/**
 * 工作台示例缺陷（界面用，降低体验门槛）
 *
 * 取自 data/eval_set_main.csv 与 data/eval_set_adversarial.csv 的真实记录，
 * 正文按 Markdown 小节还原（CSV 内换行被压成空格，此处恢复为多行以便阅读）。
 *
 * 选取原则：
 *   1. 覆盖不同模块（core / rendering / gdscript / import）与不同严重度（crash / high / low）；
 *   2. 正文长度 250–650 字符，一屏可读完，不淹没界面；
 *   3. 末条为对抗集里的信息不足样本，用于演示低置信提示与 insufficient 判定。
 *
 * 注意：此处只保留 title / body。gtTopic 与 gtSeverity 仅作为按钮上的
 * 「标注答案」小字供人工核对界面输出，不参与任何请求，也不传给模型。
 */

import type { SeverityLevel, TopicCategory } from "@/types/contract";

export type SampleIssue = {
  /** 原始 Issue 编号，仅用于溯源展示 */
  number: number;
  /** 按钮上的短标签 */
  label: string;
  title: string;
  body: string;
  /** 标注模块，人工核对用 */
  gtTopic: TopicCategory[];
  /** 标注严重度，人工核对用；对抗样本无可靠标注时为 null */
  gtSeverity: SeverityLevel | null;
  /** true 表示信息不足样本，预期触发低置信提示 */
  lowSignal?: boolean;
};

export const SAMPLE_ISSUES: readonly SampleIssue[] = [
  {
    number: 68923,
    label: "编辑器崩溃 · PlaneMesh",
    title: "Crash in editor when using PlaneMesh",
    body: `### Godot version
4.0.beta5

### System information
Windows 11

### Issue description
The editor crashes when the following settings are made in PlaneMesh.
- Subdivide Width: 254
- Subdivide Depth: 254

Perhaps, it seems to crash when the number of vertices in the mesh is just 65536.

### Steps to reproduce
1. Open reproduction project
2. Select "MeshInstance3D" node
3. In inspector, extend "Mesh" property
4. Set "Subdivide Depth" to 254

### Minimal reproduction project
PlaneMeshBug.zip`,
    gtTopic: ["core"],
    gtSeverity: "crash",
  },
  {
    number: 68760,
    label: "渲染 · 项目管理器空白",
    title: "macOS with Intel Iris Graphics - Godot 4 beta 5 Project Manager using OpenGL3 is empty.",
    body: `### Godot version
v4.0.beta5.official

### System information
macOS Big Sur v11.6.8, MacBook Pro (Retina, 13-inch, Early 2015), 2,7 GHz Dual-Core Intel Core i5, Intel Iris Graphics 6100 1536 MB, 8GB RAM

### Issue description
When launching Godot, the Project Manager doesn't show anything at all. I can open the project through the project.godot file and everything seems to be working well.

### Steps to reproduce
Just launching the Godot app.

### Minimal reproduction project
_No response_`,
    gtTopic: ["rendering"],
    gtSeverity: "high",
  },
  {
    number: 68977,
    label: "GDScript · 常量参数报错",
    title: "GDScript 2.0: Argument of a function marked as constant if it is of a custom type",
    body: `### Godot version
4.0.beta5 and currently last build of 11e1c83

### System information
MacOS 10.15.7

### Issue description
Last line of code in **Steps to reproduce** produces a parser error on last line with "Cannot assign a new value to a constant."

Maybe that is some intended behavior, but if \`baz\` is of type \`Object\` the restriction is lifted and no error is produced.

### Steps to reproduce
\`\`\`gd
class Foo extends Object:
  pass

func bar( baz: Foo ) -> void:
  baz = Foo.new()
\`\`\`

### Minimal reproduction project
N/A`,
    gtTopic: ["gdscript"],
    gtSeverity: "low",
  },
  {
    number: 68822,
    label: "资源导入 · SVG 失败",
    title: "Specific SVG file with bundled PNG image fails to be imported",
    body: `### Godot version
4.0 Beta 5

### System information
M1 MacBook Pro Arm 32gb

### Issue description
### Single SVG file crashes Godot

I have a game on Godot 3.5 and use the plug in dialogic 2.0 for my dialog.

Single SVG file crashes Godot. Size of SVG is tiny. Under 1mb (854 kb).

### Steps to reproduce
introduce and upload single svg file to file system.

Game Engine Crashes...

### Minimal reproduction project
In comment below...`,
    gtTopic: ["import"],
    gtSeverity: "high",
  },
  {
    number: 69102,
    label: "信息不足样本（演示低置信）",
    title: '"HScrollBar", pull insensitive',
    body: "000000000000000000000000000000000",
    gtTopic: ["gui", "input"],
    gtSeverity: null,
    lowSignal: true,
  },
];
