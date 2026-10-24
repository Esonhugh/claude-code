# 插件与 Marketplace

> 英文名：`plugins-marketplace` · 领域：插件与扩展 · [返回功能索引](README.md)

## 作用与效果

扩展 marketplace、favorite scope、auto-update、插件热加载（`/reload-plugins`）与失败回滚，兼容官方插件名称。`--plugin-url` 为本会话下载插件 zip；安装时套用 manifest/marketplace 的 `defaultEnabled`。启动时自动登记 Esonhugh-Marketplace（只在已启用插件引用它时声明），其 hooks 视同官方。

## 配置

| 配置项 | 位置 | 写法 | 说明 |
| --- | --- | --- | --- |
| `--plugin-dir <path>` | CLI（可重复） | 目录 | 只对本会话生效 |
| `--plugin-url <url>` | CLI（可重复） | http/https zip | 30 秒超时、256 MiB 上限，缓存于 0700 会话目录 |
| `enabledPlugins` | settings | `{"name@marketplace": true}` | 启停 |
| `defaultEnabled` | 插件 manifest | `true` / `false` | 安装时写入 |
| `disableSideloadFlags` | 托管设置 | `true` | 拒绝 `--plugin-dir` / `--plugin-url` |

## 效果

启动 footer 显示 marketplace 自动安装：

```text
  ? for shortcuts                        ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

`claude plugin --help`：

```text
Usage: claude plugin|plugins [options] [command]
Manage Claude Code plugins
Options:
  -h, --help                           Display help for command
Commands:
  disable [options] [plugin]           Disable an enabled plugin
  enable [options] <plugin>            Enable a disabled plugin
  help [command]                       display help for command
  install|i [options] <plugin>         Install a plugin from available
                                       marketplaces (use plugin@marketplace for
                                       specific marketplace)
  list [options]                       List installed plugins
  marketplace                          Manage Claude Code marketplaces
  test [options] [dir]                 Run plugin author tests
  uninstall|remove [options] <plugin>  Uninstall an installed plugin
  update [options] <plugin>            Update a plugin to the latest version
                                       (restart required to apply)
  validate [options] <path>            Validate a plugin or marketplace manifest
```
