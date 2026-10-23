# Frozen JSON-in / JSON-out entry. Expressions arrive as a whitelist AST.
# This process never calls eval or exec.
import json
import math
import sys

PREFIXES = (
    ("da", 1e1),
    ("Y", 1e24), ("Z", 1e21), ("E", 1e18), ("P", 1e15), ("T", 1e12),
    ("G", 1e9), ("M", 1e6), ("k", 1e3), ("h", 1e2),
    ("d", 1e-1), ("c", 1e-2), ("m", 1e-3),
    ("u", 1e-6), ("µ", 1e-6), ("μ", 1e-6),
    ("n", 1e-9), ("p", 1e-12), ("f", 1e-15), ("a", 1e-18), ("z", 1e-21), ("y", 1e-24),
)

UNITS = {
    "m": (1.0, (1, 0, 0, 0, 0, 0, 0)),
    "s": (1.0, (0, 1, 0, 0, 0, 0, 0)),
    "kg": (1.0, (0, 0, 1, 0, 0, 0, 0)),
    "g": (1e-3, (0, 0, 1, 0, 0, 0, 0)),
    "A": (1.0, (0, 0, 0, 1, 0, 0, 0)),
    "K": (1.0, (0, 0, 0, 0, 1, 0, 0)),
    "mol": (1.0, (0, 0, 0, 0, 0, 1, 0)),
    "cd": (1.0, (0, 0, 0, 0, 0, 0, 1)),
    "N": (1.0, (1, -2, 1, 0, 0, 0, 0)),
    "J": (1.0, (2, -2, 1, 0, 0, 0, 0)),
    "W": (1.0, (2, -3, 1, 0, 0, 0, 0)),
    "Pa": (1.0, (-1, -2, 1, 0, 0, 0, 0)),
    "Hz": (1.0, (0, -1, 0, 0, 0, 0, 0)),
    "V": (1.0, (2, -3, 1, -1, 0, 0, 0)),
    "C": (1.0, (0, 1, 0, 1, 0, 0, 0)),
    "ohm": (1.0, (2, -3, 1, -2, 0, 0, 0)),
    "F": (1.0, (-2, 4, -1, 2, 0, 0, 0)),
    "H": (1.0, (2, -2, 1, -2, 0, 0, 0)),
    "T": (1.0, (0, -2, 1, -1, 0, 0, 0)),
    "Wb": (1.0, (2, -2, 1, -1, 0, 0, 0)),
    "rad": (1.0, (0, 0, 0, 0, 0, 0, 0)),
    "sr": (1.0, (0, 0, 0, 0, 0, 0, 0)),
    "min": (60.0, (0, 1, 0, 0, 0, 0, 0)),
    "h": (3600.0, (0, 1, 0, 0, 0, 0, 0)),
    "day": (86400.0, (0, 1, 0, 0, 0, 0, 0)),
    "eV": (1.602176634e-19, (2, -2, 1, 0, 0, 0, 0)),
}

CONSTANTS = {"pi", "E", "oo", "I"}
DIMLESS = (0, 0, 0, 0, 0, 0, 0)


class Fail(Exception):
    def __init__(self, status, **kwargs):
        super().__init__(status)
        self.status = status
        self.kwargs = kwargs


OUT_PATH = None


def emit(payload):
    text = json.dumps(payload, ensure_ascii=False)
    if OUT_PATH:
        with open(OUT_PATH, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)


def blank(req, status, method, **kwargs):
    body = {
        "status": status,
        "op": req.get("op"),
        "profile": req.get("profile"),
        "mode": req.get("mode"),
        "engine": "py",
        "engineVersion": req.get("_engineVersion"),
        "method": method,
        "inputsEcho": req.get("inputsEcho"),
        "exact": None,
        "numeric": None,
        "lab": None,
        "resultRef": None,
        "missing": [],
        "seed": None,
    }
    body.update(kwargs)
    return body


def main():
    global OUT_PATH
    if len(sys.argv) >= 3:
        OUT_PATH = sys.argv[2]
        with open(sys.argv[1], encoding="utf-8") as handle:
            raw = handle.read()
    else:
        raw = sys.stdin.read()
    req = json.loads(raw or "{}")
    op = req.get("op")
    if op == "__health__":
        try:
            import numpy
            import scipy
            import sympy
        except Exception as exc:
            emit({"ok": False, "error": str(exc)})
            return
        emit({"ok": True, "numpy": numpy.__version__, "scipy": scipy.__version__, "sympy": sympy.__version__})
        return
    try:
        import numpy  # noqa: F401
        import scipy  # noqa: F401
        import sympy
    except Exception:
        emit(blank(req, "engine_unavailable", "import"))
        return
    req["_engineVersion"] = f"sympy {sympy.__version__}"
    req["_sympy"] = sympy
    try:
        emit(dispatch(req))
    except Fail as fail:
        emit(blank(req, fail.status, fail.kwargs.pop("method", op), **fail.kwargs))
    except Exception:
        traceback = __import__("traceback").format_exc()
        if OUT_PATH:
            with open(f"{OUT_PATH}.err", "w", encoding="utf-8") as handle:
                handle.write(traceback)
        else:
            sys.stderr.write(traceback)
        sys.exit(1)


def dispatch(req):
    op = req["op"]
    args = req.get("args") or {}
    table = {
        "expr.eval": op_eval,
        "calc.limit": op_limit,
        "calc.diff": op_diff,
        "calc.integrate": op_integrate,
        "calc.series": op_series,
        "calc.ode": op_ode,
        "la.det": op_det,
        "la.rank": op_rank,
        "la.inverse": op_inverse,
        "la.rref": op_rref,
        "la.solve": op_solve,
        "la.eigen": op_eigen,
        "la.diag": op_diag,
        "la.nullspace": op_nullspace,
        "la.gramschmidt": op_gramschmidt,
        "la.least_squares": op_least_squares,
        "fit.linear": op_fit,
        "stats.reduce": op_reduce,
        "uncertainty.propagate": op_propagate,
        "units.convert": op_convert,
        "units.check": op_check,
    }
    if op not in table:
        return blank(req, "engine_unavailable", "not_implemented")
    return table[op](req, args)


def op_eval(req, args):
    sympy = req["_sympy"]
    env = {"funcs": set(), "ivar": None}
    expr = build(args["expr"], env, sympy)
    variables = args.get("vars") or {}
    require_units = req.get("profile") in ("physics", "physics_lab")
    dim = dimension_of(args["expr"], variables, require_units)
    result_unit = args.get("resultUnit")
    target = parse_unit(result_unit) if result_unit else dim
    if result_unit and target[1] != dim[1]:
        raise Fail("dimension_error", method="units")
    subs = {}
    saw_uncertainty = False
    centers = []
    uncs = []
    symbols = []
    for name, raw in variables.items():
        value, unit, uncertainty, present = quantity_of(raw)
        if value is None:
            raise Fail("missing_input", missing=[name], method="eval")
        scale = parse_unit(unit)[0] if unit else 1.0
        symbol = sympy.Symbol(name)
        symbols.append(symbol)
        si = sympy.Rational(str(value)) * sympy.Rational(str(scale)) if isinstance(value, (int, float)) else value
        subs[symbol] = si
        if present:
            saw_uncertainty = True
            uncs.append(0.0 if uncertainty is None else float(uncertainty) * scale)
        else:
            uncs.append(0.0)
        centers.append(symbol)
    substituted = sympy.simplify(expr.xreplace(subs))
    mode = req.get("mode")
    if mode == "exact":
        body = blank(req, "ok", "symbolic", exact=exact_of(substituted, sympy))
        if args.get("alsoNumeric"):
            body["numeric"] = {"value": float(substituted.evalf()), "unit": result_unit}
        return body
    value = float(substituted.evalf())
    out_scale = target[0] or 1.0
    shown = value / out_scale
    uncertainty = None
    if saw_uncertainty:
        variance = 0.0
        grads = []
        for symbol, unc in zip(symbols, uncs):
            grad = complex(sympy.diff(expr, symbol).xreplace(subs).evalf()).real
            grads.append(grad)
            variance += (grad * unc) ** 2
        covariance = args.get("covariance")
        if covariance:
            for i, gi in enumerate(grads):
                for j in range(i + 1, len(grads)):
                    variance += 2 * gi * grads[j] * float(covariance[i][j])
        uncertainty = math.sqrt(variance) / out_scale
        coverage = float(args.get("coverageFactor") or req.get("coverageFactor") or 1)
        uncertainty *= coverage
    payload = {"value": shown, "unit": result_unit}
    if mode == "lab":
        return blank(req, "ok", "eval", lab={**payload, "uncertainty": uncertainty})
    numeric = dict(payload)
    if uncertainty is not None:
        numeric["uncertainty"] = uncertainty
    return blank(req, "ok", "eval", numeric=numeric)


def op_propagate(req, args):
    copied = dict(args)
    if "coverageFactor" not in copied and req.get("coverageFactor"):
        copied["coverageFactor"] = req["coverageFactor"]
    result = op_eval(req, copied)
    if result["status"] == "ok":
        result["method"] = "propagate"
    return result


def op_limit(req, args):
    sympy = req["_sympy"]
    expr = build(args["expr"], {"funcs": set(), "ivar": None}, sympy)
    var = sympy.Symbol(args["var"])
    point = as_bound(args["point"], sympy)
    kwargs = {}
    if args.get("dir"):
        kwargs["dir"] = args["dir"]
    result = sympy.limit(expr, var, point, **kwargs)
    return finish_exact(req, result, sympy, "limit")


def op_diff(req, args):
    sympy = req["_sympy"]
    expr = build(args["expr"], {"funcs": set(), "ivar": None}, sympy)
    respect = args.get("respect")
    if respect:
        for item in respect:
            expr = sympy.diff(expr, sympy.Symbol(item["var"]), int(item.get("order") or 1))
    else:
        if "var" not in args:
            raise Fail("missing_input", missing=["var"], method="diff")
        expr = sympy.diff(expr, sympy.Symbol(args["var"]), int(args.get("order") or 1))
    return finish_exact(req, sympy.simplify(expr), sympy, "diff")


def op_integrate(req, args):
    sympy = req["_sympy"]
    expr = build(args["expr"], {"funcs": set(), "ivar": None}, sympy)
    var = sympy.Symbol(args["var"])
    if "a" in args or "b" in args:
        if "a" not in args or "b" not in args:
            raise Fail("missing_input", missing=["a" if "a" not in args else "b"], method="integrate")
        result = sympy.integrate(expr, (var, as_bound(args["a"], sympy), as_bound(args["b"], sympy)))
    else:
        result = sympy.integrate(expr, var)
    result = sympy.simplify(result)
    if divergent(result, sympy):
        return blank(req, "diverges", "integrate")
    if not elementary(result, sympy):
        body = blank(req, "no_closed_form", "integrate")
        if args.get("alsoNumeric") and result.free_symbols == set():
            body["numeric"] = {"value": float(result.evalf()), "unit": None}
        return body
    return finish_exact(req, result, sympy, "integrate")


def op_series(req, args):
    sympy = req["_sympy"]
    expr = build(args["expr"], {"funcs": set(), "ivar": None}, sympy)
    var = sympy.Symbol(args["var"])
    point = as_bound(args.get("point", 0), sympy)
    order = int(args.get("order") or 6)
    result = expr.series(var, point, order).removeO()
    return finish_exact(req, sympy.simplify(result), sympy, "series")


def op_ode(req, args):
    sympy = req["_sympy"]
    func_name = args["func"]
    ivar = args["ivar"]
    env = {"funcs": {func_name}, "ivar": ivar}
    expr = build(args["eq"], env, sympy)
    func = sympy.Function(func_name)
    x = sympy.Symbol(ivar)
    ics = None
    if args.get("ics"):
        ics = {}
        for item in args["ics"]:
            point = as_bound(item["point"], sympy)
            value = as_bound(item["value"], sympy)
            order = int(item.get("order") or 0)
            if order == 0:
                ics[func(point)] = value
            else:
                ics[sympy.diff(func(x), x, order).subs(x, point)] = value
    try:
        sol = sympy.dsolve(expr, func(x), ics=ics)
    except Exception:
        return blank(req, "no_closed_form", "ode")
    if isinstance(sol, list):
        sol = sol[0]
    expr_sol = sol.rhs if getattr(sol, "rhs", None) is not None else sol
    if not elementary(expr_sol, sympy):
        return blank(req, "no_closed_form", "ode")
    return finish_exact(req, sympy.simplify(expr_sol), sympy, "ode")


def op_det(req, args):
    matrix = as_matrix(req, args["matrix"])
    return finish_exact(req, matrix.det(), req["_sympy"], "det")


def op_rank(req, args):
    matrix = as_matrix(req, args["matrix"])
    return finish_exact(req, matrix.rank(), req["_sympy"], "rank")


def op_inverse(req, args):
    matrix = as_matrix(req, args["matrix"])
    if matrix.det() == 0:
        return blank(req, "singular", "inverse")
    return finish_exact(req, matrix.inv(), req["_sympy"], "inverse")


def op_rref(req, args):
    sympy = req["_sympy"]
    matrix = as_matrix(req, args["matrix"])
    reduced, _pivots = matrix.rref(simplify=True, normalize_last=True)
    return finish_exact(req, reduced, sympy, "rref")


def op_solve(req, args):
    sympy = req["_sympy"]
    matrix = as_matrix(req, args["a"])
    target = sympy.Matrix(len(args["b"]), 1, [as_number(item, sympy) for item in args["b"]])
    augmented = matrix.row_join(target)
    if matrix.rank() < matrix.cols or matrix.rank() != augmented.rank():
        return blank(req, "singular", "solve")
    return finish_exact(req, matrix.solve(target), sympy, "solve")


def op_eigen(req, args):
    sympy = req["_sympy"]
    matrix = as_matrix(req, args["matrix"])
    parts = []
    for value, mult, vectors in matrix.eigenvects():
        rendered = [sympy.sstr(vector) for vector in vectors]
        parts.append(f"{sympy.sstr(value)} (mult {mult}): {rendered}")
    text = "; ".join(parts)
    return finish_exact(req, text, sympy, "eigen", latex=sympy.latex(matrix.eigenvects()))


def op_diag(req, args):
    sympy = req["_sympy"]
    matrix = as_matrix(req, args["matrix"])
    if not matrix.is_diagonalizable():
        return blank(req, "ok", "not_diagonalizable", exact={"expr": "not_diagonalizable", "latex": "\\text{not diagonalizable}", "diagonalizable": False})
    change, diagonal = matrix.diagonalize()
    text = f"P={sympy.sstr(change)}; D={sympy.sstr(diagonal)}"
    return finish_exact(req, text, sympy, "diag", latex=sympy.latex(diagonal))


def op_nullspace(req, args):
    sympy = req["_sympy"]
    matrix = as_matrix(req, args["matrix"])
    basis = matrix.nullspace()
    text = ", ".join(sympy.sstr(vector) for vector in basis) or "[]"
    return finish_exact(req, text, sympy, "nullspace")


def op_gramschmidt(req, args):
    sympy = req["_sympy"]
    vectors = [sympy.Matrix([as_number(item, sympy) for item in row]) for row in args["vectors"]]
    orthogonal = sympy.GramSchmidt(vectors, orthonormal=bool(args.get("orthonormal")))
    text = ", ".join(sympy.sstr(vector) for vector in orthogonal)
    return finish_exact(req, text, sympy, "gramschmidt")


def op_least_squares(req, args):
    sympy = req["_sympy"]
    matrix = as_matrix(req, args["a"])
    target = sympy.Matrix(len(args["b"]), 1, [as_number(item, sympy) for item in args["b"]])
    normal = matrix.T * matrix
    if normal.det() == 0:
        return blank(req, "singular", "least_squares")
    solution = normal.solve(matrix.T * target)
    return finish_exact(req, solution, sympy, "least_squares")


def op_fit(req, args):
    xs, x_unit = column(args["x"], req)
    ys, y_unit = column(args["y"], req)
    if len(xs) != len(ys) or len(xs) < 2:
        raise Fail("missing_input", missing=["x", "y"], method="ols")
    weights = None
    if args.get("weights") is not None:
        weights = [float(item) for item in args["weights"]]
        if len(weights) != len(xs):
            raise Fail("missing_input", missing=["weights"], method="ols")
    slope, intercept, correlation, slope_uncertainty = linreg(xs, ys, weights)
    coverage = float(args.get("coverageFactor") or req.get("coverageFactor") or 1)
    if slope_uncertainty is not None:
        slope_uncertainty *= coverage
    unit = None
    if x_unit and y_unit:
        unit = y_unit if x_unit in ("1", "") else f"{y_unit}/{x_unit}"
    details = {
        "value": slope,
        "uncertainty": slope_uncertainty,
        "unit": unit,
        "intercept": intercept,
        "r": correlation,
        "n": len(xs),
    }
    if req.get("mode") == "numeric":
        return blank(req, "ok", "ols", numeric=details)
    if req.get("mode") == "exact":
        return blank(req, "ok", "ols", exact={"expr": repr(slope), "latex": repr(slope), "intercept": intercept, "r": correlation})
    return blank(req, "ok", "ols", lab=details)


def op_reduce(req, args):
    values, unit = column(args["values"], req)
    if len(values) < 1:
        raise Fail("missing_input", missing=["values"], method="reduce")
    n = len(values)
    mean = sum(values) / n
    if n < 2:
        sample = None
        uncertainty = None
    else:
        sample = math.sqrt(sum((item - mean) ** 2 for item in values) / (n - 1))
        coverage = float(args.get("coverageFactor") or req.get("coverageFactor") or 1)
        uncertainty = coverage * sample / math.sqrt(n)
    return blank(req, "ok", "reduce", lab={
        "value": mean,
        "uncertainty": uncertainty,
        "unit": unit,
        "sampleStd": sample,
        "n": n,
    })


def op_convert(req, args):
    source = parse_unit(args["unit"])
    target = parse_unit(args["to"])
    if source[1] != target[1]:
        raise Fail("dimension_error", method="convert")
    value = float(args["value"]) * source[0] / target[0]
    return blank(req, "ok", "convert", numeric={"value": value, "unit": args["to"]})


def op_check(req, args):
    try:
        dimension_of(args["expr"], {name: {"value": 1, "unit": unit} for name, unit in args["units"].items()}, True)
    except Fail:
        raise
    return blank(req, "ok", "check", numeric={"value": True})


def column(items, req):
    if isinstance(items, dict) and "value" in items:
        items = items["value"]
    values = []
    unit = None
    require = req.get("profile") in ("physics", "physics_lab")
    for index, item in enumerate(items):
        value, item_unit, _uncertainty, _present = quantity_of(item)
        if value is None:
            raise Fail("missing_input", missing=[index], method="column")
        if item_unit:
            if unit is None:
                unit = item_unit
            elif parse_unit(unit)[1] != parse_unit(item_unit)[1] or parse_unit(unit)[0] != parse_unit(item_unit)[0]:
                raise Fail("dimension_error", method="units")
        elif unit is not None or require:
            raise Fail("dimension_error", method="units")
        values.append(float(value))
    return values, unit


def quantity_of(raw):
    if isinstance(raw, bool) or raw is None:
        return None, None, None, False
    if isinstance(raw, (int, float)):
        return raw, None, None, False
    if isinstance(raw, str):
        return None, None, None, False
    if isinstance(raw, dict):
        present = "uncertainty" in raw
        return raw.get("value"), raw.get("unit"), raw.get("uncertainty"), present
    return None, None, None, False


def linreg(xs, ys, weights):
    n = len(xs)
    ws = weights or [1.0] * n
    sw = sum(ws)
    sx = sum(w * x for w, x in zip(ws, xs))
    sy = sum(w * y for w, y in zip(ws, ys))
    sxx = sum(w * x * x for w, x in zip(ws, xs))
    sxy = sum(w * x * y for w, x, y in zip(ws, xs, ys))
    den = sw * sxx - sx * sx
    if den == 0:
        raise Fail("singular", method="ols")
    slope = (sw * sxy - sx * sy) / den
    intercept = (sxx * sy - sx * sxy) / den
    mx = sum(xs) / n
    my = sum(ys) / n
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    correlation = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(vx * vy)
    if n < 3:
        uncertainty = None
    elif weights is None:
        residual = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
        centered = sum((x - (sx / sw)) ** 2 for x in xs)
        uncertainty = math.sqrt(residual / (n - 2) / centered)
    else:
        centered = sum(w * (x - sx / sw) ** 2 for w, x in zip(ws, xs))
        uncertainty = math.sqrt(1 / centered) if centered else None
    return slope, intercept, correlation, uncertainty


def as_matrix(req, rows):
    sympy = req["_sympy"]
    return sympy.Matrix([[as_number(item, sympy) for item in row] for row in rows])


def as_number(value, sympy):
    if isinstance(value, dict):
        value = value.get("value")
    if isinstance(value, bool) or value is None:
        raise Fail("missing_input", missing=["value"], method="number")
    if isinstance(value, str):
        if value in ("oo", "inf"):
            return sympy.oo
        if value in ("-oo", "-inf"):
            return -sympy.oo
        return sympy.Rational(value)
    if isinstance(value, int):
        return sympy.Integer(value)
    if isinstance(value, float):
        return sympy.Rational(str(value))
    raise Fail("missing_input", missing=["value"], method="number")


def as_bound(value, sympy):
    return as_number(value, sympy)


def build(node, env, sympy):
    if isinstance(node, str):
        raise Fail("engine_unavailable", method="rejected_source")
    kind = node["type"]
    if kind == "num":
        return sympy.Rational(node["value"])
    if kind == "name":
        name = node["name"]
        if name == "pi":
            return sympy.pi
        if name == "E":
            return sympy.E
        if name == "oo":
            return sympy.oo
        if name == "I":
            return sympy.I
        if name in env["funcs"]:
            return sympy.Function(name)(sympy.Symbol(env["ivar"])) if env.get("ivar") else sympy.Function(name)
        return sympy.Symbol(name)
    if kind == "unary":
        arg = build(node["arg"], env, sympy)
        return arg if node["op"] == "+" else -arg
    if kind == "binop":
        left = build(node["left"], env, sympy)
        right = build(node["right"], env, sympy)
        if node["op"] == "+":
            return left + right
        if node["op"] == "-":
            return left - right
        if node["op"] == "*":
            return left * right
        if node["op"] == "/":
            return left / right
        if node["op"] == "**":
            return left ** right
        raise Fail("engine_unavailable", method="rejected_source")
    if kind == "call":
        args = [build(arg, env, sympy) for arg in node["args"]]
        return apply_func(node["name"], args, sympy)
    raise Fail("engine_unavailable", method="rejected_source")


def apply_func(name, args, sympy):
    table = {
        "sin": sympy.sin, "cos": sympy.cos, "tan": sympy.tan,
        "asin": sympy.asin, "acos": sympy.acos, "atan": sympy.atan, "atan2": sympy.atan2,
        "sinh": sympy.sinh, "cosh": sympy.cosh, "tanh": sympy.tanh,
        "exp": sympy.exp, "log": sympy.log, "log10": lambda z: sympy.log(z, 10),
        "sqrt": sympy.sqrt, "Abs": sympy.Abs, "sign": sympy.sign,
        "floor": sympy.floor, "ceiling": sympy.ceiling, "Min": sympy.Min, "Max": sympy.Max,
    }
    if name == "Derivative":
        target = args[0]
        if isinstance(target, sympy.FunctionClass):
            var = args[1]
            order = int(args[2]) if len(args) > 2 else 1
            return sympy.Derivative(target(var), var, order)
        rest = []
        index = 1
        while index < len(args):
            var = args[index]
            if index + 1 < len(args) and args[index + 1].is_number:
                rest.extend([var, int(args[index + 1])])
                index += 2
            else:
                rest.append(var)
                index += 1
        return sympy.Derivative(target, *rest)
    if name not in table:
        raise Fail("engine_unavailable", method="rejected_source")
    return table[name](*args)


def exact_of(expr, sympy):
    if isinstance(expr, str):
        return {"expr": expr, "latex": expr}
    return {"expr": sympy.sstr(expr), "latex": sympy.latex(expr)}


def finish_exact(req, expr, sympy, method, latex=None):
    if not isinstance(expr, str) and divergent(expr, sympy):
        return blank(req, "diverges", method)
    exact = exact_of(expr, sympy)
    if latex:
        exact["latex"] = latex
    body = blank(req, "ok", method, exact=exact)
    if req.get("args", {}).get("alsoNumeric") and not isinstance(expr, str):
        try:
            body["numeric"] = {"value": float(expr.evalf()), "unit": None}
        except Exception:
            body["numeric"] = None
    return body


def divergent(expr, sympy):
    if expr in (sympy.oo, -sympy.oo, sympy.zoo, sympy.nan):
        return True
    return bool(getattr(expr, "has", lambda *_args: False)(sympy.oo, -sympy.oo, sympy.zoo, sympy.nan))


def elementary(expr, sympy):
    specials = []
    for name in ("erf", "erfc", "Ei", "Si", "Ci", "li", "expint", "fresnels", "fresnelc", "gamma", "uppergamma", "lowergamma", "hyper", "meijerg", "besselj", "bessely", "airyai", "polylog", "Integral"):
        obj = getattr(sympy, name, None)
        if obj is not None:
            specials.append(obj)
    return not any(expr.has(item) for item in specials)


def dimension_of(node, variables, require_units):
    if node["type"] == "num":
        return (1.0, DIMLESS)
    if node["type"] == "name":
        name = node["name"]
        if name in CONSTANTS:
            return (1.0, DIMLESS)
        raw = variables.get(name)
        if raw is None:
            raise Fail("missing_input", missing=[name], method="units")
        _value, unit, _u, _p = quantity_of(raw if isinstance(raw, dict) else {"value": raw})
        if unit:
            return parse_unit(unit)
        if require_units:
            raise Fail("dimension_error", method="units")
        return (1.0, DIMLESS)
    if node["type"] == "unary":
        return dimension_of(node["arg"], variables, require_units)
    if node["type"] == "binop":
        left = dimension_of(node["left"], variables, require_units)
        right = dimension_of(node["right"], variables, require_units)
        if node["op"] in ("+", "-"):
            if left[1] != right[1]:
                raise Fail("dimension_error", method="units")
            return left
        if node["op"] == "*":
            return (left[0] * right[0], tuple(a + b for a, b in zip(left[1], right[1])))
        if node["op"] == "/":
            return (left[0] / right[0], tuple(a - b for a, b in zip(left[1], right[1])))
        if node["op"] == "**":
            if node["right"]["type"] != "num":
                raise Fail("dimension_error", method="units")
            power = float(node["right"]["value"]) if "/" not in node["right"]["value"] else eval_rational(node["right"]["value"])
            if right[1] != DIMLESS and power != 0:
                raise Fail("dimension_error", method="units")
            return (left[0] ** power, tuple(a * power for a in left[1]))
    if node["type"] == "call":
        if node["name"] in ("sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "log10", "sinh", "cosh", "tanh"):
            arg = dimension_of(node["args"][0], variables, require_units)
            if arg[1] != DIMLESS:
                raise Fail("dimension_error", method="units")
            return (1.0, DIMLESS)
        if node["name"] in ("Abs", "sign", "sqrt"):
            return dimension_of(node["args"][0], variables, require_units) if node["name"] != "sqrt" else pow_dim(dimension_of(node["args"][0], variables, require_units), 0.5)
        if node["name"] in ("Min", "Max"):
            dims = [dimension_of(arg, variables, require_units) for arg in node["args"]]
            if any(item[1] != dims[0][1] for item in dims):
                raise Fail("dimension_error", method="units")
            return dims[0]
        if node["name"] == "Derivative":
            return (1.0, DIMLESS)
    raise Fail("dimension_error", method="units")


def pow_dim(dim, power):
    return (dim[0] ** power, tuple(a * power for a in dim[1]))


def eval_rational(text):
    num, den = text.split("/")
    return float(num) / float(den)


def parse_unit(text):
    if not isinstance(text, str) or not text.strip():
        raise Fail("dimension_error", method="units")
    parser = UnitParser(text.replace(" ", ""))
    qty = parser.parse()
    parser.skip_unused()
    if parser.index != len(parser.text):
        raise Fail("dimension_error", method="units")
    return qty


class UnitParser:
    def __init__(self, text):
        self.text = text
        self.index = 0

    def parse(self):
        qty = self.factor()
        while self.index < len(self.text) and self.text[self.index] in "*/":
            op = self.text[self.index]
            self.index += 1
            other = self.factor()
            if op == "*":
                qty = (qty[0] * other[0], tuple(a + b for a, b in zip(qty[1], other[1])))
            else:
                qty = (qty[0] / other[0], tuple(a - b for a, b in zip(qty[1], other[1])))
        return qty

    def factor(self):
        if self.index < len(self.text) and self.text[self.index] == "(":
            self.index += 1
            qty = self.parse()
            if self.index >= len(self.text) or self.text[self.index] != ")":
                raise Fail("dimension_error", method="units")
            self.index += 1
        else:
            qty = named_unit(self.read_name())
        if self.index < len(self.text) and self.text[self.index] == "^":
            self.index += 1
            sign = 1
            if self.index < len(self.text) and self.text[self.index] == "-":
                sign = -1
                self.index += 1
            start = self.index
            while self.index < len(self.text) and self.text[self.index].isdigit():
                self.index += 1
            if start == self.index:
                raise Fail("dimension_error", method="units")
            power = sign * int(self.text[start:self.index])
            qty = (qty[0] ** power, tuple(part * power for part in qty[1]))
        return qty

    def read_name(self):
        start = self.index
        while self.index < len(self.text) and (self.text[self.index].isalpha() or self.text[self.index] in "µμ"):
            self.index += 1
        if start == self.index:
            raise Fail("dimension_error", method="units")
        return self.text[start:self.index]

    def skip_unused(self):
        return None


def named_unit(name):
    if name in UNITS:
        return UNITS[name]
    for prefix, scale in PREFIXES:
        if name.startswith(prefix) and name[len(prefix):] in UNITS:
            unit_scale, dim = UNITS[name[len(prefix):]]
            return (scale * unit_scale, dim)
    raise Fail("dimension_error", method="units")


if __name__ == "__main__":
    main()
