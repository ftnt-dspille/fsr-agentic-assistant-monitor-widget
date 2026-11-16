"use strict";
// Static guard over the Monitor's templates (view.html and every partial under
// widgetAssets/html): nothing an analyst reads may be an emoji or pictograph,
// a banned dash, or a binding to a tool or connector-operation name. Icons are
// CSS masks (`class="ic ic-*"`), never glyphs.
//
//   make test-unit WIDGET=agenticAssistantMonitor

const fs = require("fs");
const path = require("path");

const WIDGET = path.join(__dirname, "..", "widget");
const PARTIALS = path.join(WIDGET, "widgetAssets", "html");
const FILES = [path.join(WIDGET, "view.html")].concat(
  fs.readdirSync(PARTIALS).filter((f) => f.endsWith(".html")).map((f) => path.join(PARTIALS, f)));

// Markup an analyst reads: no <style>, no HTML comments.
function markup(file) {
  return fs.readFileSync(file, "utf8").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "");
}
const GLYPHS = /[\u{1F000}-\u{1FFFF}←-⯿☀-➿×…–—️]/u;
// The audit record (an expandable tool-call chain and Turn Detail) is the one
// place raw tool names are the content.
const AUDIT_RECORD = /tab-audit\.html$|turn-detail\.html$/;
const IDENTIFIER_BINDING = /\.(operation|connector|op|tool|tool_name)\b|session_status|user_iri(?!\s*\))/;

describe("Monitor templates are free of glyphs and identifiers", () => {
  test("the template set is split into partials, view.html stays small", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(9);
    expect(fs.readFileSync(path.join(WIDGET, "view.html"), "utf8").split("\n").length).toBeLessThan(500);
    FILES.filter((f) => !/view\.html$/.test(f))
      .forEach((f) => expect(fs.readFileSync(f, "utf8").split("\n").length).toBeLessThan(250));
  });

  test.each(FILES.map((f) => [path.basename(f), f]))("%s has no emoji, arrows or banned dashes", (_n, f) => {
    const m = markup(f).match(GLYPHS);
    expect(m && m[0]).toBeFalsy();
  });

  test.each(FILES.filter((f) => !AUDIT_RECORD.test(f)).map((f) => [path.basename(f), f]))(
    "%s binds no tool or operation name", (_n, f) => {
      // Text bindings only: a click handler may pass a wire key to the controller.
      const exprs = (markup(f).match(/\{\{[\s\S]*?\}\}/g) || []).join("\n");
      const m = exprs.match(IDENTIFIER_BINDING);
      expect(m && m[0]).toBeFalsy();
    });

  test("view.html carries the shared token block and the mask icon base", () => {
    const html = fs.readFileSync(path.join(WIDGET, "view.html"), "utf8");
    expect(html).toMatch(/--soar-bg:/);
    expect(html).toMatch(/\.soc-monitor \.ic \{[^}]*mask/);
    expect(html).toMatch(/--ic: url\("data:image\/svg\+xml/);
  });
});
