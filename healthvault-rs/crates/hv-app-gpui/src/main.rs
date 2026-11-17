//! GPUI Kit desktop shell. Thin over `hv-api`, with a sidebar workspace and one detail region.

mod app;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

use app::HealthVaultApp;
use gpui_kit::AppContext;

fn run_app() {
    #[cfg(target_family = "wasm")]
    std::panic::set_hook(Box::new(|info| log_web(&format!("panic: {info}"))));
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        // The web text system has no OS font database; register one bundled face explicitly.
        let fonts: Vec<std::borrow::Cow<'static, [u8]>> =
            vec![include_bytes!("../assets/DejaVuSans.ttf").to_vec().into()];
        if let Err(error) = cx.text_system().add_fonts(fonts) {
            log_web(&format!("font registration failed: {error}"));
        }
        #[cfg(target_family = "wasm")]
        let options = gpui_kit::WindowOptions {
            window_bounds: Some(gpui_kit::WindowBounds::Windowed(gpui_kit::Bounds::new(
                Default::default(),
                gpui_kit::size(gpui_kit::px(1280.), gpui_kit::px(800.)),
            ))),
            ..Default::default()
        };
        #[cfg(not(target_family = "wasm"))]
        let options = gpui_kit::WindowOptions::default();
        #[cfg(target_family = "wasm")]
        let service = {
            app::DataSource::Web {
                base: String::new(),
            }
        };
        #[cfg(not(target_family = "wasm"))]
        let service = {
            let database = hv_storage::connection::resolve_database_path(
                std::env::var("DATABASE_PATH").ok().as_deref(),
                false,
            )
            .unwrap_or_else(|_| std::path::PathBuf::from("healthvault-local.db"));
            let store = if database.exists() {
                hv_storage::StoreHandle::open(&database)
            } else {
                hv_storage::StoreHandle::in_memory()
            };
            let store = match store {
                Ok(store) => store,
                Err(error) => {
                    tracing::warn!(%error, "falling back to an in-memory store");
                    match hv_storage::StoreHandle::in_memory() {
                        Ok(store) => store,
                        Err(error) => {
                            tracing::error!(%error, "no usable store; cannot open window");
                            return;
                        }
                    }
                }
            };
            app::DataSource::Native(Arc::new(hv_api::Service::new(store)))
        };
        if let Err(error) = gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| HealthVaultApp::new(service, window, cx))
        }) {
            tracing::error!(%error, "failed to open HealthVault window");
        }
    });
}

#[cfg(target_family = "wasm")]
fn main() {}

#[cfg(target_family = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn wasm_start() {
    run_app();
}

#[cfg(not(target_family = "wasm"))]
fn main() {
    run_app();
}

#[cfg(target_family = "wasm")]
fn log_web(message: &str) {
    web_sys::console::error_1(&wasm_bindgen::JsValue::from_str(message));
}

#[cfg(not(target_family = "wasm"))]
fn log_web(_message: &str) {}
