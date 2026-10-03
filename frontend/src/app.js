import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (status === "blocked" || verdict === "异常噪声") return "tag block";
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "blocked") return "异常噪声";
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function statusText(status) {
  if (status === "blocked") return "已挡回";
  if (status === "pending") return "待处理";
  if (status === "processing") return "处理中";
  if (status === "done") return "已判定";
  return status;
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  page: "readings",
  settings: null,
  settingsForm: { enabled: false, window_size: "", threshold_multiplier: "" },
  logs: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

// 专页开关灯、判定、写口同源：灯的状态直接取自服务端 filter_settings 单行。
async function loadSettings() {
  if (!state.token) return;
  try {
    const s = await api("/api/filter/settings");
    state.settings = s;
    // 仅在用户未手动改表单时用服务端值回填，避免覆盖输入。
    if (!state.settingsForm.touched) {
      state.settingsForm.enabled = s.enabled;
      state.settingsForm.window_size = String(s.window_size);
      state.settingsForm.threshold_multiplier = String(s.threshold_multiplier);
    }
  } catch {
    /* 灯保持上一次状态 */
  }
  m.redraw();
}

async function loadLogs() {
  if (!state.token || state.page !== "filter") return;
  try {
    state.logs = await api("/api/filter/logs");
  } catch {
    /* 忽略轮询偶发失败 */
  }
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(() => {
    loadReadings();
    loadSettings();
    loadLogs();
  }, 3000);
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.settings = null;
  state.logs = [];
  state.page = "readings";
  if (state.timer) clearInterval(state.timer);
}

const loginView = () =>
  m("div.wrap", [
    m("h1", "桥梁应变班交台"),
    m(
      "p.sub",
      "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
    ),
    m("div.card", [
      m(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            state.error = "";
            state.loading = true;
            try {
              const data = await api("/api/auth/login", {
                method: "POST",
                body: JSON.stringify(state.loginForm),
              });
              state.token = data.access_token;
              state.user = { username: data.username, role: data.role };
              localStorage.setItem(TOKEN_KEY, state.token);
              localStorage.setItem(USER_KEY, JSON.stringify(state.user));
              await Promise.all([loadReadings(), loadSettings()]);
              startPolling();
            } catch {
              state.error = "用户名或密码错误";
            } finally {
              state.loading = false;
              m.redraw();
            }
          },
        },
        [
          m("div.row", [
            m("label", [
              "用户名",
              m("input", {
                value: state.loginForm.username,
                oninput: (e) => {
                  state.loginForm.username = e.target.value;
                },
              }),
            ]),
            m("label", [
              "密码",
              m("input", {
                type: "password",
                value: state.loginForm.password,
                oninput: (e) => {
                  state.loginForm.password = e.target.value;
                },
              }),
            ]),
            m("button", { type: "submit", disabled: state.loading }, "登录"),
          ]),
          state.error ? m("p.err", state.error) : null,
        ]
      ),
      m(
        "p.sub",
        { style: { marginBottom: 0 } },
        "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
      ),
    ]),
  ]);

const submitCard = () => {
  if (state.user?.role !== "writer") return null;
  return m("div.card", [
    m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
    m(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          state.error = "";
          state.msg = "";
          state.loading = true;
          try {
            const data = await api("/api/readings", {
              method: "POST",
              body: JSON.stringify({
                span_code: state.submitForm.span_code,
                microstrain: parseFloat(state.submitForm.microstrain),
              }),
            });
            state.msg = data.message || "已提交";
            state.submitForm = { span_code: "", microstrain: "" };
            await Promise.all([loadReadings(), data.blocked ? loadLogs() : null]);
          } catch (err) {
            state.error = err.message || "提交失败";
          } finally {
            state.loading = false;
            m.redraw();
          }
        },
      },
      [
        m("div.row", [
          m("label", [
            "跨段编号",
            m("input", {
              required: true,
              placeholder: "例如 跨中S3",
              value: state.submitForm.span_code,
              oninput: (e) => {
                state.submitForm.span_code = e.target.value;
              },
            }),
          ]),
          m("label", [
            "微应变（με）",
            m("input", {
              required: true,
              type: "number",
              step: "0.1",
              value: state.submitForm.microstrain,
              oninput: (e) => {
                state.submitForm.microstrain = e.target.value;
              },
            }),
          ]),
          m("button", { type: "submit", disabled: state.loading }, "提交"),
        ]),
        state.error ? m("p.err", state.error) : null,
        state.msg ? m("p.ok", state.msg) : null,
      ]
    ),
  ]);
};

const readingsTable = () =>
  m("div.card", [
    m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
    m("table", [
      m("thead", [
        m("tr", [
          m("th", "编号"),
          m("th", "跨段"),
          m("th", "微应变"),
          m("th", "结论"),
          m("th", "说明"),
          m("th", "状态"),
          m("th", "提交人"),
        ]),
      ]),
      m(
        "tbody",
        state.rows.length
          ? state.rows.map((r) =>
              m("tr", { key: r.id, class: r.status === "blocked" ? "blocked-row" : "" }, [
                m("td", r.id),
                m("td", r.span_code),
                m("td", r.microstrain),
                m("td", [
                  m("span", { class: verdictClass(r.verdict, r.status) }, displayVerdict(r)),
                ]),
                m("td", r.reason || "—"),
                m("td", statusText(r.status)),
                m("td", r.created_by),
              ])
            )
          : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
      ),
    ]),
  ]);

const filterPage = () => {
  const isWriter = state.user?.role === "writer";
  const enabled = !!state.settings?.enabled;
  return [
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, [
        "异常噪声滤波",
        m(
          "span",
          {
            class: `lamp ${enabled ? "on" : "off"}`,
            title: enabled ? "滤波已开启" : "滤波已关闭",
          },
          enabled ? "滤波中" : "已关闭"
        ),
      ]),
      m(
        "p.sub",
        "开启后，新读数相对同跨段最近窗口读数中位的偏差超过「中位 × 倍数」时整笔挡回；关闭后立即不再新增拦截，已有流水保留。"
      ),
      m(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            state.error = "";
            state.msg = "";
            try {
              const payload = {
                enabled: state.settingsForm.enabled,
                window_size: parseInt(state.settingsForm.window_size, 10),
                threshold_multiplier: parseFloat(
                  state.settingsForm.threshold_multiplier
                ),
              };
              state.settings = await api("/api/filter/settings", {
                method: "PUT",
                body: JSON.stringify(payload),
              });
              state.settingsForm.touched = false;
              state.msg = "滤波设置已保存";
              await loadLogs();
            } catch (err) {
              state.error = err.message || "保存失败";
            }
            m.redraw();
          },
        },
        [
          m("div.row", [
            m("label.switch", [
              "滤波开关",
              m("input", {
                type: "checkbox",
                checked: state.settingsForm.enabled,
                disabled: !isWriter,
                onchange: (e) => {
                  state.settingsForm.enabled = e.target.checked;
                  state.settingsForm.touched = true;
                },
              }),
            ]),
            m("label", [
              "窗口长度（笔）",
              m("input", {
                type: "number",
                min: "1",
                max: "200",
                value: state.settingsForm.window_size,
                disabled: !isWriter,
                oninput: (e) => {
                  state.settingsForm.window_size = e.target.value;
                  state.settingsForm.touched = true;
                },
              }),
            ]),
            m("label", [
              "阈值倍数（×中位）",
              m("input", {
                type: "number",
                step: "0.1",
                min: "0.1",
                max: "100",
                value: state.settingsForm.threshold_multiplier,
                disabled: !isWriter,
                oninput: (e) => {
                  state.settingsForm.threshold_multiplier = e.target.value;
                  state.settingsForm.touched = true;
                },
              }),
            ]),
            isWriter
              ? m("button", { type: "submit" }, "保存设置")
              : m("p.sub", { style: { margin: 0 } }, "复核员只读，不能修改滤波设置"),
          ]),
          state.error ? m("p.err", state.error) : null,
          state.msg ? m("p.ok", state.msg) : null,
          state.settings?.updated_by
            ? m(
                "p.sub",
                { style: { marginBottom: 0 } },
                `最近由 ${state.settings.updated_by} 更新于 ${new Date(
                  state.settings.updated_at
                ).toLocaleString()}`
              )
            : null,
        ]
      ),
    ]),
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "过滤流水"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "流水号"),
            m("th", "读数号"),
            m("th", "跨段"),
            m("th", "读数"),
            m("th", "窗口中位"),
            m("th", "偏差"),
            m("th", "倍数"),
            m("th", "窗口"),
            m("th", "挡回原因"),
            m("th", "提交人"),
            m("th", "时间"),
          ]),
        ]),
        m(
          "tbody",
          state.logs.length
            ? state.logs.map((l) =>
                m("tr", { key: l.id }, [
                  m("td", l.id),
                  m("td", l.reading_id),
                  m("td", l.span_code),
                  m("td", l.microstrain),
                  m("td", l.baseline_median == null ? "—" : l.baseline_median),
                  m("td", l.deviation == null ? "—" : l.deviation),
                  m("td", l.threshold_multiplier),
                  m("td", l.window_size),
                  m("td", l.reason),
                  m("td", l.created_by),
                  m("td", new Date(l.created_at).toLocaleString()),
                ])
              )
            : [m("tr", m("td", { colspan: 11 }, "暂无挡回流水"))]
        ),
      ]),
    ]),
  ];
};

const App = {
  oninit() {
    loadReadings();
    loadSettings();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) return loginView();

    const isWriter = state.user?.role === "writer";
    const lampOn = !!state.settings?.enabled;

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div.topright", [
          m("div.tabs", [
            m(
              `button${state.page === "readings" ? ".active" : ".secondary"}`,
              {
                type: "button",
                onclick: () => {
                  state.page = "readings";
                  state.error = "";
                  state.msg = "";
                },
              },
              "读数台"
            ),
            m(
              `button${state.page === "filter" ? ".active" : ".secondary"}`,
              {
                type: "button",
                onclick: () => {
                  state.page = "filter";
                  state.error = "";
                  state.msg = "";
                  state.settingsForm.touched = false;
                  loadSettings();
                  loadLogs();
                },
              },
              [
                "噪声滤波",
                m(
                  "span",
                  { class: `lamp sm ${lampOn ? "on" : "off"}` },
                  lampOn ? "开" : "关"
                ),
              ]
            ),
          ]),
          m("div.userline", [
            `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
            m(
              "button.secondary",
              {
                type: "button",
                onclick: () => {
                  logout();
                  m.redraw();
                },
              },
              "退出"
            ),
          ]),
        ]),
      ]),
      state.page === "filter" ? filterPage() : [submitCard(), readingsTable()],
    ]);
  },
};

export default App;
