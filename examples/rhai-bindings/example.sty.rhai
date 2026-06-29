// example.sty.rhai — a *runtime* LaTeXML package binding, written in Rhai.
//
// latexml-oxide discovers this file when the document says
// `\usepackage{example}`: it looks for `example.sty.rhai` on the search
// path (here, right next to main.tex). No Perl `.ltxml`, no recompilation —
// drop the script beside your source and it loads at conversion time.
//
// NOTE: TeX backslashes are doubled inside Rhai strings ("\\foo", not "\foo").

// Pull in xcolor so `\color` is available — the Rhai twin of Perl's
// `RequirePackage('xcolor')`.
RequirePackage("xcolor");

// Define `\foo` to expand to purple "FOO". The returned string is real TeX
// source, re-tokenized faithfully: `\color` resolves to xcolor's control
// sequence, not to literal letters.
DefMacro("\\foo", || "{\\color{purple}FOO}");
