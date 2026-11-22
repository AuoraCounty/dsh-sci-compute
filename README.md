# 科学计算

这个仓库是 DeepSeek Harness 的 Host 插件，包名 `@local/dsh-sci-compute`，版本 0.1.3。界面上显示「科学计算」。模型列式，并挑选目录里的一项运算。插件负责把那一项算完。它不写实验报告，也不画图。

对外只有两个工具。`sci_catalog` 列出运算。`sci_compute` 执行被点名的那一项。高等数学和线性代数默认返回精确式。物理实验默认返回带不确定度的数值，并带上可以直接放进报告的字符串。

## 目录里有什么

运算一共 29 项，都挂在这两个工具后面，不再为每道题加一个新工具。

微积分有极限、导数、积分、级数和常微分方程的符号解。线性代数有行列式、秩、逆、行最简形、线性方程组、特征值、对角化、零空间、格拉姆-施密特和最小二乘。实验这边有直线拟合、重复测量、解析不确定度传递、单位换算和量纲检查。`quantity.format` 放在 JavaScript 里，格式化不另开 Python。

0.1.3 把原先只登记的七项接上了插件自带的 scipy。以前调用它们会得到 `engine_unavailable`，方法名是 `not_implemented`。现在由 Python 计算。scipy 导入失败时仍返回 `engine_unavailable`，不会改用 JavaScript 凑一个数。

这七个 id 是

```text
fit.nonlinear
uncertainty.montecarlo
signal.fft
optimize.minimize
calc.roots
calc.nintegrate
ode.ivp
```

钉死的版本写在 `dsh-sci-compute/engines/py/requirements.txt`。numpy 2.2.6，scipy 1.15.2，sympy 1.13.3。

缺实测时状态是 `missing_input`，`missing` 里写出缺的名字。插件不会用仪器标称值把空着的量填上。表面张力那组验收里，没有吊环内外径就不能算出表面张力系数。

## 克隆之后还要装运行时

`runtime/` 写在 `.gitignore` 里。仓库里没有那份嵌入式 Python，克隆完不能直接算。

需要 Node.js 20 或更新。进入 `dsh-sci-compute`，先把依赖装进这个包自己的 `node_modules`。`@deepseek-ai/schemastery` 必须能从包目录解析到。只放在 profile 里、靠提升找到的那一份，热挂载时会找不到。

然后在该目录执行

```bash
node scripts/install-runtime.mjs
```

脚本下载 Python 3.12.7 的 Windows 嵌入包，以及上面三个库的 wheel。这一步需要外网。办公环境里捆绑的 Python 有 numpy，没有 scipy 和 sympy，插件不用它。

宿主按包的真实路径加载。目录已经挂进当前进程时，改过的 `catalog/ops.json` 和 `lib/dispatch.js` 要等插件重新加载才生效。没重载之前，`sci_compute` 仍会按旧目录回答。

## 参数怎么写

实验量写成对象，里面有 `value`，需要时再加 `unit` 和 `uncertainty`。字符串 `"1 m"` 会被拒绝。复合单位写成 `m/s^2`。结果单位用 `J`、`N` 这种符号，不要写成 `joule`，也不要写成 `m/s**2`。

微分方程用 `Derivative(y)-y`。函数名和自变量分开放进 `func` 和 `ivar`。式子里不要写 `y(x)`，也不要写带逗号的 `diff(y, x)`。`y'-y=0`、初值 `y(0)=1` 时，数值解在 `x=1` 处应接近 e。

非线性拟合的自变量固定叫 `x`，式子里其他名字都是参数。`a*x**2+b` 配上横坐标 0、1、2、3 和纵坐标 3、5、11、21，得到的 `a` 是 2，`b` 是 3。

蒙特卡洛必须传入整数 `seed`，结果里原样回显。同一种子得到同一组均值和不确定度。抽样次数不写时用 10000，配置上限是 100000。超过上限会直接拒绝，不会少抽一点再当成完整结果返回。

`calc.integrate` 在精确模式下没有初等原函数时，状态是 `no_closed_form`。它不会改去跑 `calc.nintegrate`。数值积分要显式调用 `calc.nintegrate`。`exp(-x**2)` 从 0 积到 1，数值约为 0.7468241328124271。`1/x` 从 1 积到无穷，状态是 `diverges`。

`[1, 0, 1, 0]` 的离散傅里叶变换，实部是 2、0、2、0。

## 验收

在仓库根目录执行

```bash
node dsh-sci-compute/test/acceptance.mjs
```

全部通过时最后一行是 `21/21 passed`。里面包括 `x**2` 的不定积分得到 `x**3/3`，奇异矩阵不编造逆矩阵，以及上面几项数值。表面张力的定标点应重新得到斜率 354.44 mV/N。对不上时先改内核，不要改验收措辞。

取舍和作废过的方案写在 `docs/sci-compute.md`。许可证以 `dsh-sci-compute/package.json` 中的 MIT 为准。
