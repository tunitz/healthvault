//! `healthvault-mcp` in Rust: MCP stdio JSON-RPC server exposing the same 38-tool contract.
//! Only JSON-RPC goes to stdout; diagnostics go to stderr. Tools run against the local store in
//! process, so the plugin no longer needs a bearer token or an HTTP round trip.

use anyhow::{Context, Result};
use hv_api::{Service, discovery, dispatch};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

const SERVER_NAME: &str = "healthvault";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2025-06-18";

fn main() -> Result<()> {
    let database = hv_storage::connection::resolve_database_path(
        std::env::var("DATABASE_PATH").ok().as_deref(),
        std::env::var("HEALTHVAULT_TESTING").is_ok(),
    )?;
    let store = hv_storage::StoreHandle::open(&database)?;
    let service = Service::new(store);
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line.context("reading MCP request")?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = serde_json::from_str(&line).context("parsing MCP JSON-RPC request")?;
        let response = handle(&service, &request);
        let stdout = io::stdout();
        let mut out = stdout.lock();
        serde_json::to_writer(&mut out, &response)?;
        out.write_all(b"\n")?;
        out.flush()?;
    }
    Ok(())
}

fn handle(service: &Service, request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
            "capabilities": { "tools": {} },
            "instructions": "Start with healthvault_context. Confirm deletes and history refresh with the user. Apple imports stay manual."
        }),
        "notifications/initialized" => return json!({}),
        "tools/list" => discovery(),
        "tools/call" => call_tool(service, request.get("params")),
        "ping" => json!({}),
        _ => {
            return json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") }
            });
        }
    };
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn call_tool(service: &Service, params: Option<&Value>) -> Value {
    let Some(params) = params else {
        return tool_error("missing tool call parameters");
    };
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match dispatch(service, name, arguments) {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }]
        }),
        Err(error) => tool_error(&error.to_string()),
    }
}

fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> Service {
        Service::new(hv_storage::StoreHandle::in_memory().unwrap())
    }

    #[test]
    fn initialize_advertises_tools() {
        let response = handle(
            &service(),
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        );
        assert_eq!(response["result"]["capabilities"]["tools"], json!({}));
        assert_eq!(response["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[test]
    fn tools_list_exposes_the_full_contract() {
        let response = handle(
            &service(),
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        );
        assert_eq!(
            response["result"]["tools"].as_array().map_or(0, Vec::len),
            38
        );
    }

    #[test]
    fn unknown_tool_is_an_mcp_error_result() {
        let response = handle(
            &service(),
            &json!({
                "jsonrpc":"2.0","id":3,"method":"tools/call",
                "params":{"name":"upload","arguments":{}}
            }),
        );
        assert_eq!(response["result"]["isError"], true);
    }

    #[test]
    fn known_tool_returns_text_content() {
        let response = handle(
            &service(),
            &json!({
                "jsonrpc":"2.0","id":4,"method":"tools/call",
                "params":{"name":"food_template_list","arguments":{}}
            }),
        );
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .is_some_and(|text| text.contains("whey-scoop"))
        );
    }
}
