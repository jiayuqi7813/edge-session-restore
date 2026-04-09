# Edge 会话恢复工具

用于 macOS 上的 Microsoft Edge。本扩展在关闭最后一个普通窗口后保存最近一次稳定快照，并在点击工具栏图标时通过弹窗提供恢复入口。

![扩展图标](icons/icon-512.png)

## 目录

- `manifest.json`: 扩展清单
- `icons/`: 扩展图标和商店 Logo 资源
- `src/background/service-worker.js`: 会话快照、状态机、恢复事务和消息处理
- `src/popup/popup.html`: 弹窗入口
- `src/shared/`: 共享协议和纯函数
- `docs/`: Edge 商店文案与隐私政策
- `scripts/`: 打包脚本
- `tests/`: 当前纯函数测试

## 本地加载

1. 打开 Edge，进入 `edge://extensions/`
2. 打开“开发人员模式”
3. 选择“加载解压缩的扩展”
4. 选择当前目录 `/Users/bytedance/Desktop/my_job/fix edge restore`

加载完成后，点击工具栏里的扩展图标会弹出恢复面板。

## GitHub 发布内容

- 仓库结构：`manifest.json` 是入口清单，`src/` 放运行时代码，`icons/` 放扩展图标资源，`tests/` 放纯函数测试。
- 本地加载：直接在 Edge 的扩展页选择当前仓库目录加载解压缩扩展。
- Edge 商店文案：可直接参考 `docs/edge-store-listing.md`，隐私政策见 `docs/privacy-policy.md`。
- 打包上传：优先使用仓库自带脚本生成商店 zip：

```bash
bash scripts/package-extension.sh
```

也可以手动把 `manifest.json`、`src/`、`icons/`、`README.md`、`docs/` 一起压成 zip，例如：

```bash
mkdir -p dist
zip -r "dist/edge-session-restore-v1.0.0.zip" manifest.json src icons README.md docs
```

这个 zip 就是后续上传到 Microsoft Edge Add-ons 的提交包。

## 验证

```bash
npm test
node --check src/background/service-worker.js
node --check src/popup/popup.js
```

## 使用方式

1. 正常浏览并打开多个标签页或窗口
2. 点击 macOS 左上角红点关闭最后一个普通窗口
3. 点击工具栏里的“Edge 会话恢复工具”图标
4. 在弹窗里点击“恢复上次会话”

如果当前已有正在使用的工作区，页面会进入确认模式，不会直接把旧会话插入当前窗口。

## 已知边界

- 不恢复 `edge://`、扩展页、DevTools 等受保护页面
- `file://` 页面只有在扩展详情里允许访问本地文件后才会恢复
- 不承诺恢复滚动位置、表单临时内容、媒体播放状态和前进后退历史
- 无痕窗口默认不参与恢复
