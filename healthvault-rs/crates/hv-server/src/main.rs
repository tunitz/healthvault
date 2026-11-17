//! Compatibility HTTP service: preserves the MCP plugin's wire contract while the native
//! GPUI app becomes the primary UI. Binds loopback by default; LAN exposure requires an
//! explicit host and the same credentials/host allowlist as the TypeScript service.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use hv_api::auth::{AuthPolicy, LoginThrottle, SESSION_COOKIE};
use hv_api::{ApiError, Service, discovery, dispatch};
use tower_http::services::ServeDir;

#[derive(Clone)]
struct AppState {
    service: Arc<Service>,
    auth: Arc<AuthPolicy>,
    throttle: Arc<LoginThrottle>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AppState")
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/api/type-stats", get(type_stats))
        .route("/api/reminders/next", get(no_content))
        .route("/api/agent", get(tool_list))
        .route("/api/agent/{tool}", post(call_tool))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            agent_guard_public_health,
        ))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .nest_service(
            "/hv-web",
            ServeDir::new(std::env::var("HEALTHVAULT_WEB_DIR").unwrap_or_else(|_| "web".into())),
        )
        .with_state(state)
}

/// Small status page at the root so a browser opening the LAN address sees a real response.
/// The full workflow UI is the native GPUI app; this service exists for MCP/API compatibility.
async fn root() -> impl IntoResponse {
    axum::response::Html(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">\
         <title>HealthVault Rust service</title>\
         <style>body{font:15px system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1rem;color:#222}\
         h1{font-size:1.5rem}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px}\
         li{margin:.4rem 0}</style>\
         <h1>HealthVault Rust service</h1>\
         <p>Running. This is the compatibility API used by MCP clients; daily workflows live in the native GPUI app.</p>\
         <ul><li><a href=\"/health\">/health</a> — service status</li>\
         <li><code>GET /api/agent</code> — 38 tool definitions (requires session or bearer token)</li>\
         <li><code>POST /api/agent/{tool}</code> — call a tool</li></ul>\
         </html>",
    )
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "engine": "hv-server" }))
}

async fn no_content() -> StatusCode {
    StatusCode::NO_CONTENT
}

#[axum::debug_handler]
async fn type_stats(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Result<Json<serde_json::Value>, Response> {
    dispatch(&state.service, "record_types", serde_json::Value::Null)
        .map(Json)
        .map_err(wire_error)
}

async fn tool_list(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let _ = &state;
    Json(discovery())
}

#[axum::debug_handler]
async fn call_tool(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(tool): axum::extract::Path<String>,
    axum::Json(payload): axum::Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, Response> {
    dispatch(&state.service, &tool, payload)
        .map(Json)
        .map_err(wire_error)
}

/// The Host/Origin/session-or-bearer gate is applied as a route layer so unmatched paths still
/// return 404 instead of 401, exactly as the TypeScript proxy does.
async fn agent_guard_public_health(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, Response> {
    if matches!(request.uri().path(), "/" | "/health") {
        return Ok(next.run(request).await);
    }
    agent_guard(axum::extract::State(state), request, next).await
}

async fn agent_guard(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, Response> {
    let headers = request.headers();
    let host = header(headers, "host");
    let origin = header(headers, "origin");
    let proto = header(headers, "x-forwarded-proto");
    let cookie = header(headers, "cookie");
    let bearer = header(headers, "authorization");
    let scheme = request.uri().scheme_str().unwrap_or("http");
    if let Some((status, message)) =
        state
            .auth
            .agent_request_failure(host, origin, proto, scheme, cookie, bearer, now_ms())
    {
        return Err((
            StatusCode::from_u16(status).unwrap_or(StatusCode::FORBIDDEN),
            Json(serde_json::json!({ "error": message })),
        )
            .into_response());
    }
    let mut response = next.run(request).await;
    // Authenticated health data is never cached by an intermediary or a service worker.
    if let Ok(value) = "no-store".parse() {
        response.headers_mut().insert(header::CACHE_CONTROL, value);
    }
    if let Ok(value) = "Cookie, Authorization".parse() {
        response.headers_mut().insert(header::VARY, value);
    }
    Ok(response)
}

fn wire_error(error: ApiError) -> Response {
    let status = StatusCode::from_u16(error.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    if error.status() >= 500 {
        tracing::error!(code = error.wire_code(), "request failed");
    }
    (
        status,
        Json(serde_json::json!({ "error": error.to_string(), "code": error.wire_code() })),
    )
        .into_response()
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

async fn login(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::Json(payload): axum::Json<serde_json::Value>,
) -> Response {
    if state.throttle.throttled() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "too many failed logins; retry in 15 minutes" })),
        )
            .into_response();
    }
    let password = payload
        .get("password")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if !state.auth.verify_password(password) {
        state.throttle.record_failure();
        tracing::warn!(status = "failed", "login attempt rejected");
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid credentials" })),
        )
            .into_response();
    }
    state.throttle.clear();
    let token = state.auth.sign_session(now_ms());
    let max_age = hv_api::auth::SESSION_DAYS * 86_400;
    let secure = if state.auth.cookie_secure() {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!(
        "{SESSION_COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}{secure}"
    );
    (
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

async fn logout(axum::extract::State(state): axum::extract::State<AppState>) -> Response {
    state.throttle.clear();
    let secure = if state.auth.cookie_secure() {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{secure}");
    (
        StatusCode::OK,
        [
            (header::SET_COOKIE, cookie),
            (
                header::HeaderName::from_static("clear-site-data"),
                "storage,cache,cookies".to_string(),
            ),
        ],
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let auth = AuthPolicy::from_env().map_err(anyhow::Error::msg)?;
    let database = hv_storage::connection::resolve_database_path(
        std::env::var("DATABASE_PATH").ok().as_deref(),
        std::env::var("HEALTHVAULT_TESTING").is_ok(),
    )?;
    let bind: SocketAddr = std::env::var("HEALTHVAULT_BIND")
        .unwrap_or_else(|_| "127.0.0.1:3040".into())
        .parse()?;
    let store = hv_storage::StoreHandle::open(&database)?;
    let state = AppState {
        service: Arc::new(Service::new(store)),
        auth: Arc::new(auth),
        throttle: Arc::new(LoginThrottle::new()),
    };
    tracing::info!(bind = %bind, "hv-server listening");
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState {
            service: Arc::new(Service::new(hv_storage::StoreHandle::in_memory().unwrap())),
            auth: Arc::new(AuthPolicy::for_test("password")),
            throttle: Arc::new(LoginThrottle::new()),
        }
    }

    async fn call(app: Router, uri: &str, bearer: bool) -> Response {
        let mut builder = Request::builder().uri(uri).header("host", "127.0.0.1:3040");
        if bearer {
            builder = builder.header("authorization", "Bearer test-token");
        }
        app.oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn root_page_is_public() {
        let app = router(test_state());
        let response = call(app, "/", false).await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn health_is_public_but_agent_requires_authentication() {
        let app = router(test_state());
        let health = call(app.clone(), "/health", false).await;
        let health_body = String::from_utf8_lossy(
            &axum::body::to_bytes(health.into_body(), 1_000_000)
                .await
                .unwrap(),
        )
        .to_string();
        assert!(health_body.contains("status"), "{health_body}");
        let unauth = call(app.clone(), "/api/agent", false).await;
        assert_eq!(
            unauth.status(),
            StatusCode::UNAUTHORIZED,
            "{}",
            String::from_utf8_lossy(
                &axum::body::to_bytes(unauth.into_body(), 4096)
                    .await
                    .unwrap()
            )
        );
        let _ok = call(app.clone(), "/api/agent", true).await;
        assert_eq!(
            call(app.clone(), "/api/agent", true).await.status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn login_issues_a_session_cookie_used_by_the_agent_api() {
        let app = router(test_state());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("host", "127.0.0.1:3040")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"password":"password"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let value = cookie.split(';').next().unwrap();
        let authed = app
            .oneshot(
                Request::builder()
                    .uri("/api/agent")
                    .header("host", "127.0.0.1:3040")
                    .header("cookie", value)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authed.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn dispatch_route_returns_a_tool_result() {
        let app = router(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/agent/food_template_list")
                    .header("host", "127.0.0.1:3040")
                    .header("authorization", "Bearer test-token")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
