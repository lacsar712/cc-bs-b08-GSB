import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (status === "blocked" || verdict === "已挡回") return "tag blocked";
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function displayStatus(status) {
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
  filterConfig: null,
  filterForm: { enabled: false, window_size: "10", factor: "3" },
  filterFormLoaded: false,
  filterLogs: [],
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

async function loadFilterConfig(syncForm = false) {
  if (!state.token) return;
  try {
    // 开关灯与服务端判定同源：每次直接拉库内唯一配置行
    state.filterConfig = await api("/api/noise-filter/config");
    // 表单只在进页/保存后同步，避免轮询覆盖正在编辑的窗口长度与倍数
    if (syncForm || !state.filterFormLoaded) {
      state.filterForm = {
        enabled: state.filterConfig.enabled,
        window_size: String(state.filterConfig.window_size),
        factor: String(state.filterConfig.factor),
      };
      state.filterFormLoaded = true;
    }
  } catch {
    /* 灯位保持原状，下次轮询重试 */
  }
  m.redraw();
}

async function loadFilterLogs() {
  if (!state.token) return;
  try {
    state.filterLogs = await api("/api/noise-filter/logs");
  } catch {
    /* 忽略，下次轮询重试 */
  }
  m.redraw();
}

function refreshAll() {
  loadReadings();
  loadFilterConfig();
  if (state.page === "filter") loadFilterLogs();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(refreshAll, 3000);
}

const FilterPage = {
  oninit() {
    loadFilterConfig(true);
    loadFilterLogs();
  },
  view() {
    const isWriter = state.user?.role === "writer";
    const cfg = state.filterConfig;
    const on = !!cfg?.enabled;
    const form = state.filterForm;

    return [
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, [
          "噪声滤波开关",
          m(
            "span",
            {
              class: `lamp ${on ? "on" : "off"}`,
              title: on ? "滤波开启中" : "滤波已关闭",
            },
            on ? "滤波开" : "滤波关"
          ),
        ]),
        m(
          "p.sub",
          { style: { marginTop: 0 } },
          "开启后，新报送读数的突变若超过最近窗口内中位数的若干倍，将整笔挡回（不入处理队列），并在此页留下过滤流水。关闭后立即不再新增拦截，已有流水保留。"
        ),
        m(
          "form",
          {
            onsubmit: async (e) => {
              e.preventDefault();
              state.error = "";
              state.msg = "";
              const windowSize = parseInt(form.window_size, 10);
              const factor = parseFloat(form.factor);
              if (!Number.isInteger(windowSize) || windowSize <= 0) {
                state.error = "窗口长度必须是正整数";
                m.redraw();
                return;
              }
              if (!Number.isFinite(factor) || factor <= 0) {
                state.error = "过滤倍数必须是正数";
                m.redraw();
                return;
              }
              state.loading = true;
              try {
                await api("/api/noise-filter/config", {
                  method: "PUT",
                  body: JSON.stringify({
                    enabled: form.enabled,
                    window_size: windowSize,
                    factor,
                  }),
                });
                state.msg = "滤波配置已保存";
                await loadFilterConfig(true);
              } catch (err) {
                state.error = err.message || "保存失败";
              } finally {
                state.loading = false;
                m.redraw();
              }
            },
          },
          [
            m("div.row", [
              m("label.switch-label", [
                "滤波开关",
                m("input", {
                  type: "checkbox",
                  checked: form.enabled,
                  disabled: !isWriter || state.loading,
                  onchange: (e) => {
                    form.enabled = e.target.checked;
                  },
                }),
              ]),
              m("label", [
                "窗口长度（笔）",
                m("input", {
                  type: "number",
                  min: "1",
                  step: "1",
                  value: form.window_size,
                  disabled: !isWriter || state.loading,
                  oninput: (e) => {
                    form.window_size = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "过滤倍数（×中位）",
                m("input", {
                  type: "number",
                  min: "0.1",
                  step: "0.1",
                  value: form.factor,
                  disabled: !isWriter || state.loading,
                  oninput: (e) => {
                    form.factor = e.target.value;
                  },
                }),
              ]),
              isWriter
                ? m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "保存配置"
                  )
                : null,
            ]),
            isWriter
              ? null
              : m("p.err", "复核员账号只读，不能修改滤波开关与参数。"),
            cfg
              ? m(
                  "p.sub",
                  { style: { marginBottom: 0 } },
                  `最近更新：${cfg.updated_by || "—"} · ${
                    cfg.updated_at ? new Date(cfg.updated_at).toLocaleString() : "—"
                  }`
                )
              : null,
            state.error ? m("p.err", state.error) : null,
            state.msg ? m("p.ok", state.msg) : null,
          ]
        ),
      ]),
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "过滤流水"),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "时间"),
              m("th", "读数编号"),
              m("th", "跨段"),
              m("th", "微应变"),
              m("th", "窗口中位"),
              m("th", "突变幅度"),
              m("th", "阈值"),
              m("th", "窗口/倍数"),
              m("th", "挡回原因"),
              m("th", "提交人"),
            ]),
          ]),
          m(
            "tbody",
            state.filterLogs.length
              ? state.filterLogs.map((r) =>
                  m("tr", { key: r.id }, [
                    m("td", r.created_at ? new Date(r.created_at).toLocaleString() : "—"),
                    m("td", r.reading_id),
                    m("td", r.span_code),
                    m("td", r.microstrain),
                    m("td", r.median == null ? "—" : Number(r.median).toFixed(1)),
                    m("td", r.deviation == null ? "—" : Number(r.deviation).toFixed(1)),
                    m("td", r.threshold == null ? "—" : Number(r.threshold).toFixed(1)),
                    m("td", `${r.window_size} / ${r.factor}`),
                    m("td", r.reason),
                    m("td", r.created_by),
                  ])
                )
              : [m("tr", m("td", { colspan: 10 }, "暂无挡回流水"))]
          ),
        ]),
      ]),
    ];
  },
};

const App = {
  oninit() {
    loadReadings();
    loadFilterConfig();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return m(
        "div.wrap",
        [
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
                    await loadReadings();
                    await loadFilterConfig();
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
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "登录"
                  ),
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
        ]
      );
    }

    const isWriter = state.user?.role === "writer";
    const filterOn = !!state.filterConfig?.enabled;

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div.topbar-actions", [
          m(
            `button.secondary${state.page === "readings" ? ".active" : ""}`,
            {
              type: "button",
              onclick: () => {
                state.page = "readings";
                loadReadings();
              },
            },
            "读数列表"
          ),
          m(
            `button.secondary${state.page === "filter" ? ".active" : ""}`,
            {
              type: "button",
              onclick: () => {
                state.page = "filter";
                state.error = "";
                state.msg = "";
                loadFilterConfig(true);
                loadFilterLogs();
              },
            },
            [
              m(
                "span",
                {
                  class: `lamp mini ${filterOn ? "on" : "off"}`,
                  title: filterOn ? "滤波开启中" : "滤波已关闭",
                },
                "•"
              ),
              " 噪声滤波",
            ]
          ),
          `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
          m(
            "button.secondary",
            {
              type: "button",
              onclick: () => {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                state.token = "";
                state.user = null;
                state.rows = [];
                state.filterConfig = null;
                state.filterLogs = [];
                state.filterFormLoaded = false;
                if (state.timer) clearInterval(state.timer);
                m.redraw();
              },
            },
            "退出"
          ),
        ]),
      ]),
      state.page === "filter"
        ? m(FilterPage)
        : [
            isWriter
              ? m("div.card", [
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
                          await Promise.all([loadReadings(), loadFilterLogs()]);
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
                        m(
                          "button",
                          { type: "submit", disabled: state.loading },
                          "提交"
                        ),
                      ]),
                      state.error ? m("p.err", state.error) : null,
                      state.msg ? m("p.ok", state.msg) : null,
                    ]
                  ),
                ])
              : null,
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
                        m("tr", { key: r.id, class: r.status === "blocked" ? "row-blocked" : "" }, [
                          m("td", r.id),
                          m("td", r.span_code),
                          m("td", r.microstrain),
                          m("td", [
                            m(
                              "span",
                              { class: verdictClass(r.verdict, r.status) },
                              displayVerdict(r)
                            ),
                          ]),
                          m("td", r.reason || "—"),
                          m("td", displayStatus(r.status)),
                          m("td", r.created_by),
                        ])
                      )
                    : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
                ),
              ]),
            ]),
          ],
    ]);
  },
};

export default App;
