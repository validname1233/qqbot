// 临时验证脚本：可交互元素清单提取（仿 GitHub 登录页）
import { extractPage, formatPageForModel } from "../src/services/browse/extract.js";

const html = `<html><head><title>Sign in to GitHub · GitHub</title></head><body>
<form action="/session">
  <label for="login_field">Username or email address</label>
  <input type="text" name="login" id="login_field">
  <label for="password">Password</label>
  <input type="password" name="password" id="password">
  <input type="hidden" name="authenticity_token" value="x">
  <button type="submit">Sign in</button>
</form>
<a href="/signup">Create an account</a>
</body></html>`;

console.log(formatPageForModel(extractPage(html, "https://github.com/login"), "https://github.com/login"));

// 无表单页：确认不输出空节
const plain = `<html><head><title>Docs</title></head><body><p>正文一段。</p><a href="/guide">指南</a></body></html>`;
console.log("---");
console.log(formatPageForModel(extractPage(plain, "https://example.com/docs"), "https://example.com/docs"));
