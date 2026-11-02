# TROUBLESHOOTING — dsh-provider-params

Each entry uses the family format: **症状 / 原因 / 动作**. Error codes are stable; the sentence around them is not.

## E_PARAMS_UNKNOWN_VENDOR

- **症状**：工具返回 `unknown vendor "..."（E_PARAMS_UNKNOWN_VENDOR）`。
- **原因**：`from` 或 `to` 不是映射表中的 11 个 id 之一，或大小写/拼写不一致（表内查找不区分大小写，但拼写必须一致）。
- **动作**：先调用 `params.vendors`，用返回的 `id` 重试。

## E_PARAMS_UNKNOWN_PARAM

- **症状**：`strict: true` 时报 `unknown parameter: ...（E_PARAMS_UNKNOWN_PARAM）`。
- **原因**：输入对象里有既不是 canonical 名称、也不是源厂商 wire name 的键。
- **动作**：删掉该键；或改为 `strict: false`，从结果的 `unknown` 列表里确认它被跳过。

## E_PARAMS_CONFLICT

- **症状**：报 `"temperature" is supplied twice with different values（E_PARAMS_CONFLICT）`。
- **原因**：同一个参数既用了 canonical 名，又用了源厂商 wire name，且两个值不同。
- **动作**：只保留一种写法，并确认值一致。

## E_JSON_NOT_CONTAINER

- **症状**：`json.repair` 返回 `ok: false`，错误码为 `E_JSON_NOT_CONTAINER`。
- **原因**：`text` 去掉围栏后不是以 `{` 或 `[` 开头，例如传入了一个裸字符串或一段说明文字。
- **动作**：只传工具输出中的对象/数组片段；说明文字用 `text` 外的上下文承载。

## E_JSON_UNREPAIRABLE

- **症状**：`json.repair` 返回 `ok: false`、`repaired: null`，错误码为 `E_JSON_UNREPAIRABLE`。
- **原因**：文本在启用的策略下仍无法解析，例如容器闭合顺序错乱（`{"a":]`）、字符串外的结构损坏，或对应策略被关闭。
- **动作**：检查 `actions` 是否为空；打开 `escape_repair` / `trailing_comma` / `truncation_closure` 后重试。仍失败时让上游返回完整 JSON。

## E_JSON_SCHEMA_VIOLATION

- **症状**：`ok: false`，`error.message` 指向 `#/...` 路径。
- **原因**：修复后仍有字段违反声明的 schema（额外字段、类型不符、必填缺失等）。
- **动作**：按 `error.message` 的路径修上游输出；不要放宽 schema 来“通过”。

## E_JSON_SCHEMA_UNSUPPORTED

- **症状**：抛错 `... is not supported by json.repair（E_JSON_SCHEMA_UNSUPPORTED）`。
- **原因**：schema 使用了支持子集之外的关键字，例如 `oneOf`、`$ref`、`allOf`。
- **动作**：改用 `type/properties/required/additionalProperties/items/enum/const` 表达同一条约束。
