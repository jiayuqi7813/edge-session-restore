# Edge 会话恢复工具

用于 macOS 上的 Microsoft Edge。本扩展在关闭最后一个普通窗口后保存最近一次稳定快照，并在点击工具栏图标时通过弹窗提供恢复入口。

## 目录

- `manifest.json`: 扩展清单
- `src/background/service-worker.js`: 会话快照、状态机、恢复事务和消息处理
- `src/popup/popup.html`: 弹窗入口
- `src/shared/`: 共享协议和纯函数
- `tests/`: 当前纯函数测试

## 本地加载

1. 打开 Edge，进入 `edge://extensions/`
2. 打开“开发人员模式”
3. 选择“加载解压缩的扩展”
4. 选择当前目录 `/Users/bytedance/Desktop/my_job/fix edge restore`

加载完成后，点击工具栏里的扩展图标会弹出恢复面板。

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
