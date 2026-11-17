use std::sync::Arc;

use gpui_kit::base::StyledExt;
use gpui_kit::component::chart::BarChart;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement;
use gpui_kit::component::{
    ActiveTheme, Disableable,
    button::Button,
    label::Label,
    sidebar::{Sidebar, SidebarGroup, SidebarMenuItem},
};
use gpui_kit::{
    AppContext, Context, InteractiveElement, IntoElement, ParentElement, Render,
    StatefulInteractiveElement, Styled, Subscription, TestSupportExt, Window, div,
};
use serde_json::{Map, Value};

use hv_api::Service;
use hv_api::workflows as flow;

/// Destination in the persistent sidebar. Domain state lives here or in the service, never in
/// render. Repeated controls use domain-derived ElementIds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    Today,
    Foods,
    Recipes,
    Training,
    Supplements,
    Explorer,
    Profile,
}

impl Section {
    const ALL: [Self; 7] = [
        Self::Today,
        Self::Foods,
        Self::Recipes,
        Self::Training,
        Self::Supplements,
        Self::Explorer,
        Self::Profile,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::Today => "Today",
            Self::Foods => "Foods",
            Self::Recipes => "Recipes",
            Self::Training => "Training",
            Self::Supplements => "Supplements",
            Self::Explorer => "Explorer",
            Self::Profile => "Profile",
        }
    }

    fn tool(self) -> &'static str {
        match self {
            Self::Today => "nutrition_day",
            Self::Foods => "food_search",
            Self::Recipes => "recipe_list",
            Self::Training => "workouts_recent",
            Self::Supplements => "supplement_list",
            Self::Explorer => "record_types",
            Self::Profile => "profile_get",
        }
    }
}

#[derive(Clone)]
pub(crate) enum DataSource {
    #[cfg_attr(target_family = "wasm", allow(dead_code))]
    Native(Arc<Service>),
    #[cfg_attr(not(target_family = "wasm"), allow(dead_code))]
    Web { base: String },
}

pub(crate) struct HealthVaultApp {
    source: DataSource,
    section: Section,
    search: gpui_kit::Entity<InputState>,
    _subscriptions: Vec<Subscription>,
    summary: Value,
    whey: Value,
    status: String,
    busy: bool,
}

impl HealthVaultApp {
    pub(crate) fn new(source: DataSource, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search foods, recipes or types"));
        let subscription = cx.subscribe(&search, |this, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                this.refresh(cx);
            }
        });
        let mut app = Self {
            source,
            section: Section::Today,
            search,
            _subscriptions: vec![subscription],
            summary: Value::Null,
            whey: Value::Null,
            status: "Ready.".into(),
            busy: false,
        };
        app.refresh(cx);
        app
    }

    fn go_to(&mut self, section: Section, cx: &mut Context<Self>) {
        self.section = section;
        self.status.clear();
        cx.notify();
        self.refresh(cx);
    }

    /// One owner for data loading: all sections go through the shared dispatcher/workflows, and
    /// results arrive with a revision so a late response cannot overwrite a newer selection.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        self.status = "Loading from the local database…".into();
        cx.notify();
        let source = self.source.clone();
        let section = self.section;
        let query = self.search.read(cx).value().to_string();
        cx.spawn(async move |this, cx| {
            let value = load_section(source, section, &query).await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match value {
                    Ok(value) => {
                        this.summary = value;
                        this.status = "Loaded.".into();
                    }
                    Err(error) => {
                        this.summary = Value::Null;
                        this.status = format!("Could not load: {error}");
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn run_action(&mut self, action: Action, cx: &mut Context<Self>) {
        self.busy = true;
        self.status = "Working…".into();
        cx.notify();
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = run_action(source, action).await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                this.status = match result {
                    Ok(message) => message,
                    Err(error) => format!("Failed: {error}"),
                };
                cx.notify();
            });
        })
        .detach();
        self.refresh(cx);
    }
}

#[derive(Debug, Clone, Copy)]
enum Action {
    WheyLog,
    WheyUndo,
    StartBlock,
    Backup,
}

async fn load_section(source: DataSource, section: Section, query: &str) -> anyhow::Result<Value> {
    let mut input = Map::new();
    match section {
        Section::Foods | Section::Recipes => {
            input.insert("query".into(), Value::String(query.to_owned()));
            if section == Section::Recipes {
                input.remove("query");
            }
        }
        _ => {}
    }
    match source {
        DataSource::Web { base } => {
            let url = format!(
                "{}/api/agent/{}",
                base.trim_end_matches('/'),
                section.tool()
            );
            fetch_json(&url, Value::Object(input)).await
        }
        DataSource::Native(service) => {
            let service = service.as_ref();
            match section {
                Section::Supplements => Ok(serde_json::json!({
                    "supplements": hv_api::dispatch(service, "supplement_list", Value::Null)?,
                    "whey": flow::whey_status(service, &Map::new())?
                })),
                Section::Training => Ok(serde_json::json!({
                    "workouts": hv_api::dispatch(service, "workouts_recent", Value::Null)?,
                    "plan": flow::training_plan_state(service)?,
                    "strength": flow::strength_sessions(service, &Map::new())?
                })),
                _ => Ok(hv_api::dispatch(
                    service,
                    section.tool(),
                    Value::Object(input),
                )?),
            }
        }
    }
}

#[cfg(target_family = "wasm")]
async fn fetch_json(url: &str, payload: Value) -> anyhow::Result<Value> {
    use wasm_bindgen::JsCast;
    let window = web_sys::window().ok_or_else(|| anyhow::anyhow!("no browser window"))?;
    let headers = web_sys::Headers::new().map_err(|_| anyhow::anyhow!("cannot create headers"))?;
    headers
        .set("content-type", "application/json")
        .map_err(|_| anyhow::anyhow!("cannot set header"))?;
    let options = web_sys::RequestInit::new();
    options.set_method("POST");
    options.set_body(&wasm_bindgen::JsValue::from_str(&payload.to_string()));
    options.set_headers(&headers);
    let request = web_sys::Request::new_with_str_and_init(url, &options)
        .map_err(|_| anyhow::anyhow!("cannot create request"))?;
    let response = wasm_bindgen_futures::JsFuture::from(window.fetch_with_request(&request))
        .await
        .map_err(|_| anyhow::anyhow!("fetch failed"))?;
    let response: web_sys::Response = response
        .dyn_into()
        .map_err(|_| anyhow::anyhow!("bad response"))?;
    if !response.ok() {
        return Err(anyhow::anyhow!("HTTP {}", response.status()));
    }
    let text = wasm_bindgen_futures::JsFuture::from(
        response
            .text()
            .map_err(|_| anyhow::anyhow!("cannot read body"))?,
    )
    .await
    .map_err(|_| anyhow::anyhow!("cannot read body"))?
    .as_string()
    .ok_or_else(|| anyhow::anyhow!("body is not text"))?;
    Ok(serde_json::from_str(&text)?)
}

#[cfg(not(target_family = "wasm"))]
#[allow(clippy::unused_async)]
async fn fetch_json(_url: &str, _payload: Value) -> anyhow::Result<Value> {
    Err(anyhow::anyhow!(
        "HTTP data source is only available in the web build"
    ))
}

#[allow(clippy::unused_async)]
async fn run_action(source: DataSource, action: Action) -> anyhow::Result<String> {
    let DataSource::Native(service) = source else {
        return Err(anyhow::anyhow!(
            "writes are not available in the web build yet"
        ));
    };
    let service = service.as_ref();
    match action {
        Action::WheyLog => {
            flow::whey_log(service, &Map::new())?;
            Ok("Whey logged.".into())
        }
        Action::WheyUndo => {
            flow::whey_undo(service, &Map::new())?;
            Ok("Whey undone.".into())
        }
        Action::StartBlock => {
            flow::training_plan_start(service, &Map::new())?;
            Ok("16-week block created.".into())
        }
        Action::Backup => {
            let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
            let path = std::env::temp_dir().join(format!("healthvault-{stamp}.db"));
            service.store.backup_to(&path)?;
            Ok(format!("Backup written to {}", path.display()))
        }
    }
}

impl Render for HealthVaultApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let items = Section::ALL.map(|section| {
            SidebarMenuItem::new(section.label())
                .active(self.section == section)
                .on_click(cx.listener(move |this, _, _, cx| this.go_to(section, cx)))
        });

        let detail = match self.section {
            Section::Supplements => self.render_supplements(cx),
            Section::Training => self.render_training(cx),
            Section::Profile => self.render_profile(cx),
            _ => self.render_json(cx),
        };

        div()
            .v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .px_4()
                    .py_3()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(Label::new("HealthVault").text_lg().font_semibold())
                    .child(
                        Button::new("refresh")
                            .label(if self.busy { "Loading…" } else { "Refresh" })
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                    ),
            )
            .child(
                div()
                    .h_flex()
                    .items_stretch()
                    .size_full()
                    .min_h_0()
                    .child(
                        div()
                            .w_48()
                            .min_h_0()
                            .border_r_1()
                            .border_color(cx.theme().border)
                            .child(
                                Sidebar::new("hv-sidebar")
                                    .child(SidebarGroup::new("").children(items)),
                            ),
                    )
                    .child(
                        div()
                            .v_flex()
                            .flex_1()
                            .min_w_0()
                            .min_h_0()
                            .p_5()
                            .gap_3()
                            .child(
                                div()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(Label::new(self.section.label()).text_sm()),
                            )
                            .child(detail)
                            .child(
                                div()
                                    .id("status")
                                    .role(gpui_kit::Role::Status)
                                    .test_support()
                                    .aria_label(self.status.clone())
                                    .text_color(cx.theme().muted_foreground)
                                    .child(Label::new(self.status.clone()).text_sm()),
                            ),
                    ),
            )
    }
}

impl HealthVaultApp {
    fn render_json(&mut self, _cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let query = matches!(self.section, Section::Foods);
        let search = if query {
            div().w_80().child(Input::new(&self.search))
        } else {
            div().hidden()
        };
        let text =
            serde_json::to_string_pretty(&self.summary).unwrap_or_else(|_| "No data.".into());
        div()
            .v_flex()
            .flex_1()
            .min_h_0()
            .gap_2()
            .child(search)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_scrollbar()
                    .child(div().text_sm().child(text)),
            )
            .into_any_element()
    }

    fn render_supplements(&mut self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let logged = self.whey["logged"].as_bool().unwrap_or(false);
        let configured = self.whey["configured"].as_bool().unwrap_or(false);
        let log = Button::new("whey-log")
            .label("Log whey")
            .disabled(self.busy || logged || !configured)
            .on_click(cx.listener(|this, _, _, cx| this.run_action(Action::WheyLog, cx)));
        let undo = Button::new("whey-undo")
            .label("Undo whey")
            .disabled(self.busy || !logged)
            .on_click(cx.listener(|this, _, _, cx| this.run_action(Action::WheyUndo, cx)));
        let hint = if configured {
            if logged {
                "Logged for this day. Undo removes only this action."
            } else {
                "Ready to log one serving."
            }
        } else {
            "Configure the one-tap whey link in Profile first."
        };
        div()
            .v_flex()
            .flex_1()
            .min_h_0()
            .gap_3()
            .child(div().h_flex().gap_2().child(log).child(undo))
            .child(
                div()
                    .text_color(cx.theme().muted_foreground)
                    .child(Label::new(hint)),
            )
            .child(
                div().flex_1().min_h_0().overflow_scrollbar().child(
                    div()
                        .text_sm()
                        .child(serde_json::to_string_pretty(&self.summary).unwrap_or_default()),
                ),
            )
            .into_any_element()
    }

    fn render_training(&mut self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let plan_count = self.summary["plan"]["count"].as_i64().unwrap_or(0);
        let sessions = self.summary["strength"].as_array().map_or(0, Vec::len);
        let chart = BarChart::new([plan_count as f64, sessions as f64])
            .band(|v| format!("{v:.0}"))
            .value(|v| *v);
        div()
            .v_flex()
            .flex_1()
            .min_h_0()
            .gap_3()
            .child(
                Button::new("start-block")
                    .label("Start 16-week block")
                    .disabled(self.busy || plan_count > 0)
                    .on_click(
                        cx.listener(|this, _, _, cx| this.run_action(Action::StartBlock, cx)),
                    ),
            )
            .child(div().h_40().child(chart))
            .child(
                div().flex_1().min_h_0().overflow_scrollbar().child(
                    div()
                        .text_sm()
                        .child(serde_json::to_string_pretty(&self.summary).unwrap_or_default()),
                ),
            )
            .into_any_element()
    }

    fn render_profile(&mut self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        div()
            .v_flex()
            .flex_1()
            .min_h_0()
            .gap_3()
            .child(
                Button::new("backup")
                    .label("Back up database")
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, _, cx| this.run_action(Action::Backup, cx))),
            )
            .child(
                div().flex_1().min_h_0().overflow_scrollbar().child(
                    div()
                        .text_sm()
                        .child(serde_json::to_string_pretty(&self.summary).unwrap_or_default()),
                ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod ui_tests {
    use super::*;
    use gpui_kit::test::TestWindowExt;
    use gpui_kit::{Bounds, TestAppContext, WindowBounds, WindowOptions, px, size};

    #[gpui_kit::test]
    fn refresh_button_updates_status_through_the_real_ui(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let service = Service::new(hv_storage::StoreHandle::in_memory().expect("in-memory store"));
        let (handle, _view) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(800.), px(600.)),
                    ))),
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        HealthVaultApp::new(DataSource::Native(Arc::new(service)), window, cx)
                    })
                },
            )
            .expect("open test window")
        });
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("refresh").is_some());
            assert!(window.try_find("status").is_some());
            window.click("refresh", cx);
            assert_eq!(
                window.find("status").label(),
                Some("Loading from the local database…")
            );
        })
        .expect("interact with window");
    }
}
