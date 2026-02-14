# Codex Pro API

将 **Codex**（gpt-5.3-codex）以 **OpenAI 兼容 API** 形式暴露，可在 Cline、Cursor 等支持 OpenAI 接口的客户端中使用。

**For English, see [README.md](README.md).**

---

## 演示说明

**账号页 — 通过「使用 Codex 登录」添加账号（OAuth）：**

![账号页](accounts.png)

**模型页 — 查看可用模型与额度：**

![模型页](models.png)

---

## 如何开始使用

### 方式一：桌面版（推荐）

不想用命令行时，可直接安装桌面版：

1. 打开 [GitHub Releases](https://github.com/violettoolssite/codexProapi/releases)。
2. 选择最新版本（如 `v1.0.6`），在 **Assets** 中下载 **Windows 安装包**：`Codex Pro API Setup x.x.x.exe`（安装时可选路径、桌面/开始菜单快捷方式）。  
   **说明：** 桌面版目前仅提供 Windows；macOS / Linux 用户请使用下方「命令行运行」方式。
3. 安装并运行后，配置页会**直接在软件窗口内打开**，无需使用浏览器；关闭软件后，本地服务会随之关闭。账号与数据保存在您本机的用户数据目录，与安装目录分离。

### 方式二：命令行运行

需要 **Node.js** 18 或更高。在终端执行：

```bash
npm install -g codex-proapi
codex-proapi
```

或在项目目录执行 `npm install` 后运行 `npm start`。然后在浏览器打开 **http://localhost:1455/**。默认端口为 **1455**；全局安装时，账号与用量数据保存在 `~/.codex-proapi/`。

### 本地构建 Windows 安装包（开发者）

桌面版仅提供 **Windows** 安装包。在项目目录执行 `npm run dist:win`，输出在 `release/` 目录。若出现「Cannot create symbolic link」错误，请以**管理员身份**运行终端，或开启**开发者模式**（设置 → 更新和安全 → 开发者选项）后重试。

---

## 在客户端中使用（Cline、Cursor 等）

| 配置项     | 填写内容 |
|------------|----------|
| **Base URL** | `http://localhost:1455/v1`（须含 `/v1`；若使用远程或其它端口，请改为对应地址 + `/v1`） |
| **模型**     | `gpt-5.3-codex`（或 `gpt-5.2-codex`、`gpt-5-codex`、`gpt-5`、`gpt-4`） |
| **API Key**  | 任意填写（不校验；认证来自您已配置的 Codex 账号） |

**操作步骤：**

1. 在 **http://localhost:1455/** 的「账号」页点击「使用 Codex 登录」添加账号（或使用「添加账号」→「粘贴 JSON」）。
2. 在 Cline、Cursor 等客户端中按上表设置 **Base URL**（必须带 `/v1`）和**模型**，API Key 随意。
3. 照常发起对话即可，代理会使用您配置的账号进行轮询。

---

## 登录时提示「地区限制」或 access_denied

若您点击「使用 Codex 登录」后出现**地区限制**、**access_denied** 或类似提示，说明当前网络/地区无法使用该登录方式。您可以：

1. **使用网络代理（VPN）** 后再次点击「使用 Codex 登录」重试。
2. **改用粘贴 auth.json**：在能正常登录 Codex 的设备上（例如另一台电脑或已开代理的浏览器），打开 `~/.codex/auth.json`（Windows：`%USERPROFILE%\\.codex\\auth.json`）复制全部内容，在本页「账号」→「添加账号」→「粘贴 JSON」中粘贴并添加。

页面上出现此类错误时也会显示上述操作说明。

---

## 通过他人提供的链接使用时出现 403

若您是通过别人提供的网址（如 `https://xxx.com`）打开本服务，在点击「使用 Codex 登录」最后一步时出现 **403** 或「Token exchange failed」等提示，属于服务端回调地址配置问题。请联系**提供该链接的服务方**检查域名与 OAuth 回调配置；您本地无需修改。

---

## 功能说明

- **多账号轮询与故障切换** — 请求在您添加的多个账号间轮询；某账号失败时自动切换下一个。
- **配置页** — 仪表盘、模型（额度）、账号（OAuth 登录 / 粘贴 JSON）、日志、设置（语言、Base URL）。数据每 5 秒自动刷新。
- **响应式界面** — 支持桌面与手机；小屏下侧栏收起到菜单。
- **中英双语** — 界面与日志支持英文与简体中文。

本服务支持多轮对话；在客户端按 OpenAI 格式传 `messages` 即可，代理会自动处理。

---

## 使用 [free.violetteam.cloud](https://free.violetteam.cloud/) 接收验证码

若使用 [free.violetteam.cloud](https://free.violetteam.cloud/) 接收验证邮件（如注册 ChatGPT/Codex 小号），验证码到达可能稍慢，请耐心等待。若长时间未收到，请点击**重发验证码**。
