# 科学计算插件开发文档

状态：设计定稿，代码未写。日期：2026-10-21。

本文是实现依据。对话和项目笔记里更早的方案若与本文冲突，以本文为准。

## 1. 要做什么

为本机 agent 写一个 Host 插件。它是开放的科学计算框架：能力靠运算目录增加，不靠增加 agent 工具。

大学物理、高等数学、线性代数要能直接用，并且结果形态符合这三门课的习惯。这三门课是优化过的使用面，不是功能上限。FFT、蒙特卡洛、非线性拟合、优化和其他可命名的运算留在同一目录里。

模型负责列式和选择运算。插件负责计算。插件不写作文，不画图，也不代替现有的 shell。

## 2. 已作废的方案

下面三条不要再实现。

| 方案 | 为什么作废 |
|---|---|
| 四个专用工具：`lab_fit_linear`、`lab_reduce`、`lab_propagate`、`lab_format`；纯 JavaScript；不做符号计算 | 范围被一次表面张力实验卡住。后面的微积分、线代和更一般的数值计算都要改工具面 |
| 插件只覆盖大学物理、高等数学、线性代数；FFT、蒙特卡洛、信号处理不进入目录 | 用户更正过：三门课是兼容和特别优化，框架仍然开放 |
| 第一版只做 JavaScript 直线拟合，符号和 SciPy 以后再接 | 高等数学和线性代数的默认结果是精确式。没有 sympy 的第一版不能称为可用 |

仍然有效、不要丢掉的约束：

- 缺实测返回 `missing`，禁止用仪器标称值填空。表面张力报告曾在没有吊环内外径时使用 3.500 cm / 3.300 cm，这个做法禁止进入插件。
- 同一组定标点和两次拉膜电压必须复现 k = 354.44 mV/N，以及 α = 9.179×10⁻² N/m 与 1.679×10⁻¹ N/m。对不上先改计算，不改报告措辞。
- 原始点不在本仓库。写金样前从当时的手写记录取回输入。禁止用上述结果反推输入再拿来验收。

## 3. 非目标

- 不提供任意代码执行。开发继续用 `ops_bash`。
- 不把教材公式做成一个个工具。单摆周期、库仑定律等由模型列式，再调用通用运算。
- 不做 MCP。
- 不在本插件里作图。需要图时返回数组或文件路径，交给现有图表能力。
- 不写实验报告、不写题目解析。现有的实验报告技能、学习技能、答案解析技能只消费本插件的结果。
- 不把办公环境里捆绑的 Python 当作运行时。那个环境有 numpy 和 pandas，没有 scipy 和 sympy。
- 引擎缺失时不用另一种引擎凑数。

## 4. 架构

```
调用方
  sci_catalog  查看运算、剖面、引擎是否可用
  sci_compute  指定运算、参数、剖面或结果形态
        │
        ▼
  运算目录（schema、默认形态、所需引擎、实现状态）
        │
        ├── js 引擎     单位换算、小规模纯数值，不冒充 sympy / scipy
        └── py 引擎     插件自带的 numpy、scipy、sympy
                          冻结模块，JSON 进，JSON 出
        │
        ▼
  统一结果信封
```

Host 插件在 `apply` 里注册工具。注册 API 以当时的 `cordis_inspect_query`（Host `Service`）为准，本文不预设方法名。可调参数放插件 `Config`，不写死在代码里。

不新增会话事件类型。一次计算的输入和输出以工具结果为准，会话日志能重放。

## 5. 工具

只有两个。新增能力时加目录项，不加工具。

### `sci_catalog`

列出运算。支持按 `domain` 过滤，支持分页。每一项至少包含：

| 字段 | 含义 |
|---|---|
| `id` | 稳定标识，如 `calc.integrate` |
| `domain` | 领域 |
| `summary` | 一句话 |
| `engine` | `js` 或 `py` |
| `available` | 该引擎当前是否能跑 |
| `defaultMode` | 该运算未指定形态时的默认值 |
| `argsSchema` | 参数的 JSON Schema |

`available: false` 的项仍要列出来。调用它得到 `engine_unavailable`，而不是从目录消失。

### `sci_compute`

执行一个目录中的运算。

| 参数 | 必填 | 含义 |
|---|---|---|
| `op` | 是 | 目录中的运算 id |
| `args` | 是 | 符合该运算 schema 的对象 |
| `mode` | 否 | `exact`、`numeric`、`lab` 之一。传入则覆盖默认 |
| `profile` | 否 | 见第 8 节。只影响默认形态和附加检查，不改变运算本身 |

未知 `op` 返回 `unknown_op`。参数不符合 schema 时返回错误，不猜测缺省测量值。

## 6. 结果信封

所有运算返回同一形状。数组和长推导不塞进正文，只给摘要和路径。

```json
{
  "status": "ok",
  "op": "calc.integrate",
  "profile": "calculus",
  "mode": "exact",
  "engine": "py",
  "engineVersion": "sympy 1.x",
  "method": "symbolic",
  "inputsEcho": {},
  "exact": { "expr": "x**3/3", "latex": "\\frac{x^{3}}{3}" },
  "numeric": null,
  "lab": null,
  "resultRef": null,
  "missing": [],
  "seed": null
}
```

`status` 只使用这些值：

| status | 含义 |
|---|---|
| `ok` | 算出了所请求形态的结果 |
| `missing_input` | 缺测量或必填量。`missing` 列出缺什么 |
| `dimension_error` | 量纲不一致 |
| `engine_unavailable` | 目录里有这个运算，但引擎未安装或未通过自检 |
| `no_closed_form` | 请求了精确式，但没有初等闭式。不得改回小数冒充 `ok` |
| `diverges` | 极限不存在、反常积分发散，或级数发散 |
| `singular` | 矩阵奇异或线性方程组无唯一解。不得编造一个解 |
| `unknown_op` | 目录中没有该 id |

形态：

| mode | 放入的字段 | 适用 |
|---|---|---|
| `exact` | `exact.expr` 与 `exact.latex`。系数能用有理数就不用浮点 | 高等数学、线性代数的默认 |
| `numeric` | `numeric.value`，可带 `unit` | 物理理论题和一般数值计算 |
| `lab` | `lab.value`、`lab.uncertainty`、`lab.unit`，以及可直接放进报告的 `lab.text` | 大学物理实验的默认 |

调用方同时需要精确式和数值时，分两次调用，或在 `args` 里显式要求 `alsoNumeric: true`。第二次数值不得覆盖 `status`。没有闭式时 `status` 仍是 `no_closed_form`，数值如果另外算出，放在 `numeric` 并在 `method` 里写明是数值近似。

随机方法必须在参数里接收 `seed`，并在结果里原样回显。没有种子就拒绝，不自己生成后假装可复现。

## 7. 量

标量和数组都是量，而不是裸数字。

```json
{
  "value": 1.5,
  "unit": "mV",
  "uncertainty": 0.1,
  "covariance": null
}
```

- `uncertainty` 缺省表示这个量不带不确定度，不是不确定度为 0，除非调用方明确给 0。
- 相关不确定度用 `covariance` 或相关矩阵，随该次运算的变量顺序给出。
- 数组较大时不内联。内联上限由 Config `maxInlineNumbers` 控制，默认 4096 个数。超出则参数改为工作区文件路径，结果用 `resultRef` 指向摘要文件。文件内容包含形状、单位和数值。
- 单位字符串使用可解析的表达式，如 `mV`、`N/m`、`kg*m/s^2`。无法解析则报错，不忽略单位。

## 8. 剖面

剖面不是第二套工具，只决定两件事：未传 `mode` 时用哪种形态，以及是否强制做量纲检查。

| profile | 默认 mode | 附加行为 |
|---|---|---|
| `calculus` | `exact` | 无闭式、发散时返回对应 status，不用小数冒充 |
| `linear_algebra` | `exact` | 输入是整数或有理数时，行列式、秩、逆、行最简形、解和特征值保持有理数或精确式。奇异返回 `singular` |
| `physics_lab` | `lab` | 检查单位。缺测返回 `missing_input`。不读取、不代入任何仪器标称值 |
| `physics` | `numeric` | 强制检查量纲。矢量用点乘、叉乘等通用运算，不单列力学公式 |
| 省略，且未传 `mode` | 该运算自己的 `defaultMode` | 不从对话内容猜测是哪门课 |

`profile` 与 `mode` 同时传入时，`mode` 优先。剖面仍然执行它的检查。例如 `physics_lab` 加上 `mode: exact` 时，缺测依然是 `missing_input`。

## 9. 运算目录

id 一旦发布就保持稳定。实现可以分批，目录项先登记。

### 第一版必须能跑通

| id | 做什么 | 引擎 | defaultMode |
|---|---|---|---|
| `expr.eval` | 对白名单表达式代入量并求值。可带单位和不确定度 | py | numeric |
| `calc.limit` | 极限，含单侧 | py | exact |
| `calc.diff` | 导数、高阶导数、偏导 | py | exact |
| `calc.integrate` | 不定积分、定积分、反常积分 | py | exact |
| `calc.series` | 泰勒展开 | py | exact |
| `calc.ode` | 常微分方程的符号解。振动、RC/RL 暂态走这一项，不另建物理公式 | py | exact |
| `la.det` `la.rank` `la.inverse` `la.rref` `la.solve` | 行列式、秩、逆、行最简形、线性方程组 | py | exact |
| `la.eigen` `la.diag` | 特征值、特征向量、可对角化时的对角化 | py | exact |
| `la.nullspace` `la.gramschmidt` `la.least_squares` | 零空间、格拉姆-施密特、最小二乘 | py | exact |
| `fit.linear` | 普通或加权直线拟合。返回斜率、截距、相关系数和斜率不确定度 | py | lab |
| `stats.reduce` | 重复测量：均值、样本标准差、平均值的标准不确定度、n | py | lab |
| `uncertainty.propagate` | 按表达式做不确定度传递，支持协方差 | py | lab |
| `units.convert` `units.check` | 换算、判断表达式量纲是否齐次 | py | numeric |
| `quantity.format` | 把值和不确定度收成报告用字符串 | js | lab |

`expr.eval`、`calc.*` 和 `uncertainty.propagate` 的表达式不是 Python。只允许数字、名字、四则、幂、括号，以及白名单函数（`sin`、`cos`、`tan`、`exp`、`log`、`sqrt`、`Abs` 等，实现时写成显式列表）。拒绝属性访问、下标里的代码、导入和任何语句。解析失败就报错。

### 第一版只登记，引擎未就绪时可返回 `engine_unavailable`

这些 id 必须出现在 `sci_catalog` 里，不能等做完了才起名字。

| id | 做什么 |
|---|---|
| `fit.nonlinear` | 非线性曲线拟合及参数不确定度 |
| `uncertainty.montecarlo` | 蒙特卡洛传递。必须带 `seed`，并限制抽样次数 |
| `signal.fft` | 离散傅里叶变换 |
| `optimize.minimize` | 数值优化 |
| `calc.roots` | 方程求根 |
| `calc.nintegrate` | 没有闭式时的数值积分 |
| `ode.ivp` | 没有符号解时的数值初值问题 |

`calc.integrate` 在请求 `exact` 且没有初等原函数时返回 `no_closed_form`。它不悄悄改跑 `calc.nintegrate`。

## 10. 引擎

### Python

插件自带运行时，至少包括 numpy、scipy、sympy，版本钉死。启动时做一次自检：导入失败则所有 `engine: py` 的项 `available: false`。

计算进程只接受 JSON。标准输入是 `{ "op", "args", "mode" }`，标准输出是第 6 节的信封。不把模型文本拼进命令行，不执行 `eval` 或 `exec`。表达式先在插件里做白名单解析，再把语法树或已允许的 sympy 形式交给运行时。

超时、输出字节数和数组元素个数都有上限，放在 Config 里。超限返回错误，不截断成一个看起来完整的结果。

### JavaScript

`quantity.format` 和目录、信封、schema 校验放在 JS 里，这样格式化不依赖 Python 进程。JS 不实现微积分、特征值和不确定度传递。缺 Python 时这些运算就是 `engine_unavailable`。

## 11. Config

| 键 | 默认 | 作用 |
|---|---|---|
| `coverageFactor` | 1 | 实验不确定度的覆盖因子。报告若要 k = 2，由调用方传入或改配置 |
| `maxInlineNumbers` | 4096 | 内联数组上限 |
| `maxOutputBytes` | 262144 | Python 标准输出上限 |
| `timeoutMs` | 30000 | 单次运算超时 |
| `monteCarloMaxDraws` | 100000 | 蒙特卡洛抽样上限 |
| `pythonPath` | 插件运行时 | 只允许指向插件自带解释器，不默认使用系统或办公捆绑的 Python |

## 12. 包

工作区内一个 Host 插件包，建议名 `@local/dsh-sci`。

```
package.json          dsh.bundle.patch 指向 cordis.patch.yml
cordis.patch.yml      insert，id: dsh-sci
index.js              export function apply；inject 包含 tools；export const Config
locale/zh.json        meta.title、meta.description
locale/en.json
icon.svg              原创图标，随包导出
catalog/ops.json      运算目录
engines/py/runtime.py 冻结计算入口
test/                 金样和不变量
```

`package.json` 导出 `locale` 和 `icon`，并把运行文件列入 `files`。安装用 `plugin_manager` 的 `install_bundle`，目标是这个包的目录。不要手改 profile 的 `cordis.patch.yml`。

中文显示名用「科学计算」。描述写明：开放计算目录，高等数学和线性代数默认精确式，物理实验默认不确定度。

## 13. 验收

第一版同时满足下面各项才算完成。

1. `sci_catalog` 同时列出第 9 节的「必须能跑通」和「只登记」两组。后者在引擎未接好时 `available: false`。
2. `integrate(x**2, x)` 在 `profile: calculus` 下得到 `x**3/3` 和对应 LaTeX，`status` 为 `ok`。
3. 一个整数矩阵的 `la.rref` 或 `la.eigen` 给出有理数或精确式，不先变成浮点。
4. 奇异方程组返回 `singular`，不返回一个凑出来的解。
5. 发散的反常积分或极限返回 `diverges`。
6. 表面张力金样：用取回的原始定标点和两次拉膜电压，得到 k = 354.44 mV/N 和两次 α。吊环内外径不在输入里时，`status` 为 `missing_input`，`missing` 含内外径，结果里不得出现 3.500 cm 或 3.300 cm。
7. 对 `fit.nonlinear` 或 `signal.fft`，在实现完成前调用得到 `engine_unavailable`，而不是一个 JS 近似值。
8. 表达式参数中的属性访问或导入被拒绝。
9. 工具面仍然只有 `sci_catalog` 和 `sci_compute`。

## 14. 实现顺序

1. 包骨架、Config、两个工具、空目录和信封校验。
2. 接上插件自带的 Python，打通一次 `expr.eval`。
3. 补齐第 9 节必须能跑通的运算，并写第 13 节的测试。表面张力测试在原始点取回之后再断言数值。
4. 把只登记的运算标成 `available: false`，确认调用不会落到 JS 近似。
5. 用 `install_bundle` 装到当前 profile，再用 `cordis_inspect_query` 确认两个工具可见。然后按第 13 节实际调用一遍。

后加 FFT、蒙特卡洛或新的课程习惯时，只加目录项和运行时函数，不改这两个工具的参数形状。
