// 工作台 UI 前端（前端方案 §5）：文件树（惰性展开）+ Monaco 编辑器 + 保存
// （mtime 乐观锁）。原生 JS，无构建链；token 从 /ws/<token> 路径提取，
// API 走 Authorization: Bearer 头。
"use strict";

/* ---------- token 与 API 封装 ---------- */

const TOKEN = /^\/ws\/([A-Za-z0-9_-]{32})$/.exec(location.pathname)?.[1] ?? "";

async function api(path, opts = {}) {
  const res = await fetch(`/ws/api/${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------- 小组件：toast / 对话框 ---------- */

const toastEl = document.getElementById("toast");
let toastTimer = null;
function toast(message, kind = "") {
  toastEl.textContent = message;
  toastEl.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ""; }, 3000);
}

const overlay = document.getElementById("overlay");
const dialogText = document.getElementById("dialog-text");
const dialogInput = document.getElementById("dialog-input");
const dialogButtons = document.getElementById("dialog-buttons");

// buttons: [{label, primary?, danger?, value}]；value 为输入框内容（输入模式）
function dialog(text, buttons, { input = null } = {}) {
  return new Promise((resolve) => {
    dialogText.textContent = text;
    dialogInput.hidden = input === null;
    dialogInput.value = input ?? "";
    dialogButtons.innerHTML = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      if (b.primary) btn.className = "primary";
      if (b.danger) btn.className = "danger";
      btn.onclick = () => {
        overlay.hidden = true;
        // 输入模式下只有主按钮（确认）返回输入框的值；其余按钮（取消等）
        // 返回按钮自身的 value——否则点"取消"也会把输入值当确认结果带出去。
        let result = b.value;
        if (b.primary && input !== null) result = dialogInput.value;
        resolve(result);
      };
      dialogButtons.appendChild(btn);
    }
    overlay.hidden = false;
    if (input !== null) setTimeout(() => dialogInput.focus(), 0);
  });
}

/* ---------- 状态 ---------- */

const treeEl = document.getElementById("tree");
const crumbEl = document.getElementById("crumb");
const editorPane = document.getElementById("editor-pane");
const btnSave = document.getElementById("btn-save");
const btnRename = document.getElementById("btn-rename");
const btnDelete = document.getElementById("btn-delete");

let editor = null;          // monaco editor 实例（Monaco 加载完成后创建）
let current = null;         // { path, baseMtimeMs, dirty }
let selectedNode = null;    // 树上选中节点 { path, isDir, el }

// 脏状态钩子：Monaco 加载后在下方 require 回调里赋真身（此前为空操作——
// setModel 调用点在顶层，钩子必须顶层可见；Monaco 未就绪时 setModel 本就
// 不会发生，空实现足够）。
let hookDirtyListener = () => {};

/* ---------- Monaco ---------- */

// worker 代理（AMD 标准做法）：worker 从 data: URL 起步，importScripts 到
// 同源的 workerMain.js，再按 label 分发到保留的三个 LSP worker。
const MONACO_BASE = `${location.origin}/ws/static/monaco`;
window.MonacoEnvironment = {
  getWorkerUrl(workerId, label) {
    const workerPath =
      label === "json" ? "vs/language/json/jsonWorker.js" :
      label === "css" || label === "scss" || label === "less" ? "vs/language/css/cssWorker.js" :
      label === "html" ? "vs/language/html/htmlWorker.js" :
      "vs/base/worker/workerMain.js";
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(
      `self.MonacoEnvironment={baseUrl:"${MONACO_BASE}"};importScripts("${MONACO_BASE}/${workerPath}");`,
    )}`;
  },
};

const LANGS = {
  py: "python", js: "javascript", ts: "typescript", json: "json", md: "markdown",
  css: "css", scss: "scss", less: "less", html: "html", htm: "html", xml: "xml",
  yml: "yaml", yaml: "yaml", sh: "shell", bash: "shell", ini: "ini", cfg: "ini",
  sql: "sql", csv: "plaintext", txt: "plaintext",
};
const langOf = (path) => LANGS[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

require.config({ paths: { vs: "/ws/static/monaco/vs" } });
require(["vs/editor/editor.main"], () => {
  editor = monaco.editor.create(document.getElementById("editor"), {
    theme: "vs-dark",
    language: "plaintext",
    minimap: { enabled: true },
    automaticLayout: true,
    readOnly: true,
    fontSize: 14,
  });
  // 脏状态监听挂在 model 上（onDidChangeContent 是 model 的 API）。双保险：
  // ① onDidChangeModel 事件（换绑时对新 model 补挂）；② 每次 setModel 后由
  // 调用点同步直挂（hookDirtyListener 幂等——用标记避免重复挂同一 model）。
  // 实现赋给顶层 hookDirtyListener（调用点在外层作用域）。
  const hooked = new WeakSet();
  hookDirtyListener = (model) => {
    if (model === null || model === undefined || hooked.has(model)) return;
    hooked.add(model);
    model.onDidChangeContent(() => {
      if (current === null) return;
      current.dirty = true;
      document.title = `● ${current.path.split("/").pop()} - 工作台`;
      btnSave.disabled = false;
    });
  };
  editor.onDidChangeModel((e) => hookDirtyListener(e.newModel));
  hookDirtyListener(editor.getModel());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);
  monaco.languages.typescript?.javascriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true, // 无 tsconfig 语义检查，只留语法着色
  });
}, (err) => {
  document.getElementById("empty-hint").textContent =
    "编辑器加载失败（Monaco 资源缺失），请检查部署或联系管理员";
  console.error(err);
});

/* ---------- 文件树 ---------- */

// 渲染一个目录的直属子项到容器。目录节点惰性展开（首次点击才 list 子目录）。
async function renderDir(container, dirPath) {
  const { entries } = await api(`list?dir=${encodeURIComponent(dirPath)}`);
  container.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "node";
    empty.style.color = "#666";
    empty.textContent = "（空）";
    container.appendChild(empty);
    return;
  }
  for (const e of entries) {
    const node = document.createElement("div");
    node.className = "node";
    const path = dirPath === "" ? e.name : `${dirPath}/${e.name}`;
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = e.isDir ? "▸" : "▪";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = e.name;
    node.append(icon, name);
    node.onclick = () => selectNode({ path, isDir: e.isDir, el: node, icon, container });
    container.appendChild(node);
  }
}

async function selectNode(n) {
  if (selectedNode !== null) selectedNode.el.classList.remove("selected");
  selectedNode = n;
  n.el.classList.add("selected");
  btnRename.disabled = btnDelete.disabled = false;
  crumbEl.textContent = n.path;

  if (n.isDir) {
    const expanded = n.el.classList.toggle("expanded");
    n.icon.textContent = expanded ? "▾" : "▸";
    if (expanded) {
      // 惰性展开：子容器不存在则建；已存在则复用（折叠只是 display:none）
      let children = n.el.nextElementSibling;
      if (children === null || !children.classList.contains("children")) {
        children = document.createElement("div");
        children.className = "children";
        children.style.paddingLeft = "16px";
        n.el.after(children);
        await renderDir(children, n.path);
      } else {
        children.style.display = "";
      }
    } else {
      const children = n.el.nextElementSibling;
      if (children !== null && children.classList.contains("children")) {
        children.style.display = "none";
      }
    }
  } else {
    await openFile(n.path);
  }
}

/* ---------- 打开 / 保存 ---------- */

async function openFile(path) {
  if (current !== null && current.dirty) {
    const choice = await dialog(
      `${current.path} 有未保存的修改，切换文件将丢弃。是否先保存？`,
      [
        { label: "保存并继续", value: "save", primary: true },
        { label: "直接丢弃", value: "drop", danger: true },
        { label: "取消", value: null },
      ],
    );
    if (choice === null) return;
    if (choice === "save") {
      const ok = await saveFile();
      if (!ok) return;
    }
  }
  try {
    const f = await api(`file?path=${encodeURIComponent(path)}`);
    if (f.binary) {
      toast("二进制文件，仅提供下载列表，不做编辑", "error");
      return;
    }
    current = { path, baseMtimeMs: f.mtimeMs, dirty: false };
    editorPane.classList.add("active");
    editor.setModel(monaco.editor.createModel(f.content, langOf(path)));
    hookDirtyListener(editor.getModel());
    editor.updateOptions({ readOnly: false });
    document.title = `${path.split("/").pop()} - 工作台`;
    btnSave.disabled = false;
  } catch (err) {
    toast(err.message, "error");
  }
}

async function saveFile() {
  if (current === null || editor === null) return false;
  try {
    const result = await api("file", {
      method: "PUT",
      body: JSON.stringify({
        path: current.path,
        content: editor.getValue(),
        baseMtimeMs: current.baseMtimeMs,
      }),
    });
    current.baseMtimeMs = result.mtimeMs;
    current.dirty = false;
    document.title = `${current.path.split("/").pop()} - 工作台`;
    btnSave.disabled = true;
    toast("已保存", "ok");
    return true;
  } catch (err) {
    if (err.status === 409) {
      const choice = await dialog(
        `${err.message}。要如何处理？`,
        [
          { label: "重载磁盘版（丢弃我的修改）", value: "reload", danger: true },
          { label: "用我的版本覆盖", value: "force", primary: true },
          { label: "取消", value: null },
        ],
      );
      if (choice === "reload") {
        const path = current.path;
        current.dirty = false; // 绕过 openFile 的未保存拦截
        await openFile(path);
      } else if (choice === "force") {
        const stale = current.baseMtimeMs;
        try {
          // 覆盖 = 不带 baseMtimeMs 重发。先读当前 mtime 作为新基线（文件存在
          // 但客户端无基线时服务端仍判冲突，所以这里带刚读到的值强制对齐）。
          const f = await api(`file?path=${encodeURIComponent(current.path)}`);
          const result = await api("file", {
            method: "PUT",
            body: JSON.stringify({
              path: current.path,
              content: editor.getValue(),
              baseMtimeMs: f.mtimeMs,
            }),
          });
          current.baseMtimeMs = result.mtimeMs;
          current.dirty = false;
          document.title = `${current.path.split("/").pop()} - 工作台`;
          btnSave.disabled = true;
          toast("已覆盖保存", "ok");
        } catch (err2) {
          toast(err2.message, "error");
        }
        void stale;
      }
    } else {
      toast(err.message, "error");
    }
    return false;
  }
}

/* ---------- 工具条动作 ---------- */

async function refreshTree() {
  // 全树重拉：局部刷新的收益不值得为它维护 DOM 映射
  selectedNode = null;
  btnRename.disabled = btnDelete.disabled = true;
  await renderDir(treeEl, "");
}

document.getElementById("btn-new-file").onclick = async () => {
  const name = await dialog("新文件名（可含相对子目录，如 notes/a.md）：", [
    { label: "创建", value: true, primary: true },
    { label: "取消", value: null },
  ], { input: "" });
  if (name === null || name.trim() === "") return;
  try {
    await api("file", {
      method: "PUT",
      body: JSON.stringify({ path: name.trim(), content: "", baseMtimeMs: null }),
    });
    await refreshTree();
    toast("已创建", "ok");
  } catch (err) {
    toast(err.message, "error");
  }
};

document.getElementById("btn-new-dir").onclick = async () => {
  const name = await dialog("新目录名：", [
    { label: "创建", value: true, primary: true },
    { label: "取消", value: null },
  ], { input: "" });
  if (name === null || name.trim() === "") return;
  try {
    await api("dir", { method: "POST", body: JSON.stringify({ path: name.trim() }) });
    await refreshTree();
    toast("已创建", "ok");
  } catch (err) {
    toast(err.message, "error");
  }
};

btnRename.onclick = async () => {
  if (selectedNode === null) return;
  const to = await dialog(`重命名「${selectedNode.path}」为：`, [
    { label: "确定", value: true, primary: true },
    { label: "取消", value: null },
  ], { input: selectedNode.path });
  if (to === null || to.trim() === "" || to === selectedNode.path) return;
  try {
    await api("rename", {
      method: "POST",
      body: JSON.stringify({ from: selectedNode.path, to: to.trim() }),
    });
    if (current !== null && current.path === selectedNode.path) {
      current.path = to.trim();
      document.title = `${current.path.split("/").pop()} - 工作台`;
    }
    await refreshTree();
    toast("已重命名", "ok");
  } catch (err) {
    toast(err.message, "error");
  }
};

btnDelete.onclick = async () => {
  if (selectedNode === null) return;
  const sure = await dialog(
    `确定删除「${selectedNode.path}」？${selectedNode.isDir ? "目录及其全部内容将被递归删除，" : ""}此操作不可恢复。`,
    [
      { label: "删除", value: true, danger: true },
      { label: "取消", value: null },
    ],
  );
  if (sure !== true) return;
  try {
    await api(`file?path=${encodeURIComponent(selectedNode.path)}`, { method: "DELETE" });
    if (current !== null && current.path === selectedNode.path) {
      current = null;
      editor.setModel(monaco.editor.createModel("", "plaintext"));
      hookDirtyListener(editor.getModel());
      editor.updateOptions({ readOnly: true });
      editorPane.classList.remove("active");
      document.title = "工作台";
      btnSave.disabled = true;
    }
    await refreshTree();
    toast("已删除", "ok");
  } catch (err) {
    toast(err.message, "error");
  }
};

btnSave.onclick = saveFile;

window.addEventListener("beforeunload", (e) => {
  if (current !== null && current.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ---------- 启动 ---------- */

(async () => {
  if (TOKEN === "") {
    document.getElementById("empty-hint").textContent = "链接格式不正确，请重新发 /工作台 领取";
    return;
  }
  try {
    await refreshTree();
  } catch (err) {
    if (err.status === 401) {
      document.getElementById("empty-hint").textContent =
        "链接已过期或被吊销。请在 QQ 里重新发 /工作台 领取新链接";
    } else {
      toast(err.message, "error");
    }
  }
})();
