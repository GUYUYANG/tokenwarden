# Contributing / 参与贡献

## Good contributions / 适合的贡献

- A host adapter with documented event mappings.
  带有完整事件映射文档的新宿主适配器。
- A deterministic test for an audit finding.
  针对某项审计发现的确定性测试。
- A smaller reproduction of a false positive.
  更小规模的误报复现。
- A privacy or installer hardening fix.
  隐私或安装器安全性加固。
- Documentation that separates observed facts from inference.
  区分观测事实与推断的文档改进。

## Fixtures / 测试样例

Never attach a real full transcript. Replace it with the smallest synthetic JSONL fixture that reproduces the behavior. Remove:
不要附上真实完整会话。请用能够复现问题的最小合成 JSONL 数据替代，并移除：

- names and personal paths;
  姓名和私人路径；
- session identifiers;
  会话标识；
- prompts and assistant text not required by the test;
  测试不需要的提示词和助手正文；
- images;
  图片；
- tokens, cookies, API keys, and account identifiers.
  token、Cookie、API Key 和账户标识。

## Verification / 验证

Run:
运行：

```bash
npm run verify
```

For a user-visible change, describe:
对于用户可见变更，请描述：

- the exact action;
  精确操作；
- the expected observable result;
  预期可观察结果；
- the automated evidence;
  自动化证据；
- any real runtime verification;
  实际运行验证；
- any remaining uncertainty.
  仍然存在的不确定性。

A passing unit test is not proof that an OS-level Hook lifecycle executed.
单元测试通过，不等于操作系统层面的 Hook 生命周期已经真实执行。

## Pull requests / Pull Request 规范

Keep changes focused. State the failure mode, the evidence, the smallest fix, and the tests that would fail without it. Do not include private task history in commits, fixtures, issue text, or screenshots.
保持改动聚焦。说明失败模式、证据、最小修复，以及在修复前会失败的测试。不要在提交、测试数据、Issue 或截图中包含私人任务历史。
