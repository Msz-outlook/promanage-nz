// Dark mode. The theme block is the one part of the app that runs in <head>,
// above and independent of the app block, because it has to resolve before the
// first paint.
//
// Two of the cases below are registry checks rather than logic checks, in the
// spirit of page-render.test.mjs: the way this feature breaks is not a function
// returning the wrong value, it is a *colour that only exists in one theme*.
// A token added to :root with no dark counterpart, or a rule that names a hex
// directly, both look completely fine in whichever theme the author had open.

export const name = 'theme';

export default ({ test, app, eq, deepEq, ok, notOk }) => {
  /* ---- resolution -------------------------------------------------- */

  test('an explicit choice resolves to itself, whatever the device prefers', async () => {
    eq(await app(() => resolveTheme('dark')), 'dark');
    eq(await app(() => resolveTheme('light')), 'light');
  });

  test('system resolves to whatever the device actually prefers', async () => {
    const r = await app(() => ({ resolved: resolveTheme('system'), dark: systemPrefersDark() }));
    eq(r.resolved, r.dark ? 'dark' : 'light');
  });

  test('an unrecognised stored mode reads as system, not as a broken theme', async () => {
    // Junk gets into this key the same way it gets anywhere else: an older
    // build, a half-written value, someone poking at devtools.
    const modes = await app(() => {
      const before = localStorage.getItem('promanage_theme');
      const out = [];
      for (const v of ['', 'nonsense', 'DARK', 'null', '{}']) {
        localStorage.setItem('promanage_theme', v);
        out.push(getThemeMode());
      }
      localStorage.removeItem('promanage_theme');
      out.push(getThemeMode()); // absent entirely
      if (before !== null) localStorage.setItem('promanage_theme', before);
      return out;
    });
    deepEq(modes, ['system', 'system', 'system', 'system', 'system', 'system']);
  });

  test('applyTheme stamps an explicit light/dark, never "system"', async () => {
    // The stylesheet has one dark block keyed on this attribute and no
    // prefers-color-scheme query, so leaving "system" on the element would
    // silently mean light.
    const r = await app(() => {
      const before = document.documentElement.getAttribute('data-theme');
      const out = ['system', 'light', 'dark'].map((m) => {
        applyTheme(m);
        return document.documentElement.getAttribute('data-theme');
      });
      document.documentElement.setAttribute('data-theme', before);
      return out;
    });
    ok(r.every((t) => t === 'light' || t === 'dark'), `got ${JSON.stringify(r)}`);
    eq(r[1], 'light');
    eq(r[2], 'dark');
  });

  /* ---- the toggle -------------------------------------------------- */

  test('cycling reaches all three modes and returns to where it started', async () => {
    // A two-way toggle would drop "follow my device" permanently on the first
    // press; this is the case that pins the third state being reachable.
    const seen = await app(() => {
      const beforeMode = localStorage.getItem('promanage_theme');
      const beforeAttr = document.documentElement.getAttribute('data-theme');
      localStorage.setItem('promanage_theme', 'system');
      const out = [];
      for (let i = 0; i < 4; i++) { cycleTheme(); out.push(getThemeMode()); }
      if (beforeMode === null) localStorage.removeItem('promanage_theme');
      else localStorage.setItem('promanage_theme', beforeMode);
      document.documentElement.setAttribute('data-theme', beforeAttr);
      return out;
    });
    deepEq(seen, ['light', 'dark', 'system', 'light']);
  });

  test('the toggle button describes the theme for screen readers, not just an emoji', async () => {
    const r = await app(() => {
      const beforeMode = localStorage.getItem('promanage_theme');
      const beforeAttr = document.documentElement.getAttribute('data-theme');
      const btn = document.getElementById('theme-toggle');
      const out = {};
      for (const m of ['system', 'light', 'dark']) {
        localStorage.setItem('promanage_theme', m);
        updateThemeToggle();
        out[m] = { label: btn.getAttribute('aria-label'), icon: btn.textContent, title: btn.title };
      }
      if (beforeMode === null) localStorage.removeItem('promanage_theme');
      else localStorage.setItem('promanage_theme', beforeMode);
      updateThemeToggle();
      document.documentElement.setAttribute('data-theme', beforeAttr);
      return out;
    });
    for (const mode of ['system', 'light', 'dark']) {
      ok(r[mode].label && r[mode].label.length > 8, `${mode}: aria-label is "${r[mode].label}"`);
      eq(r[mode].title, r[mode].label, `${mode}: title matches the label`);
      ok(r[mode].icon.trim().length > 0, `${mode}: has an icon`);
    }
    // Each mode has to be distinguishable from the other two.
    eq(new Set(['system', 'light', 'dark'].map((m) => r[m].icon)).size, 3);
    eq(new Set(['system', 'light', 'dark'].map((m) => r[m].label)).size, 3);
  });

  test('the theme block leaks no incidental globals for the app block to collide with', async () => {
    // A top-level `var` in this block creates a NON-CONFIGURABLE window
    // property, and a later top-level `const` of the same name in the app
    // block then fails to instantiate — a SyntaxError that takes the whole app
    // down rather than just the theme. `mq` is the one that nearly shipped.
    const leaked = await app(() =>
      ['mq', 'onSystemThemeChange', 'theme', 'mode', 'meta', 'btn', 'ui', 'next', 'v']
        .filter((n) => Object.prototype.hasOwnProperty.call(window, n))
    );
    deepEq(leaked, [], 'generic names leaked to window by the theme block');
  });

  /* ---- the palette is complete ------------------------------------- */

  test('every colour token defined for light is also defined for dark', async () => {
    // THE registry check for this feature. Add --foo:#abc to :root, use it in a
    // rule, forget the dark block, and the app looks perfect in light and wrong
    // in dark — with nothing to report it but someone's eyes.
    const missing = await app(() => {
      const rules = [...document.styleSheets[0].cssRules];
      const find = (sel) => rules.find((r) => r.selectorText === sel);
      const light = find(':root');
      const dark = find(':root[data-theme="dark"]');
      if (!light || !dark) return { error: `light=${!!light} dark=${!!dark}` };

      const tokens = (rule) => [...rule.style].filter((p) => p.startsWith('--'));
      const darkSet = new Set(tokens(dark));
      // Only colour-valued tokens need a dark counterpart — --radius does not.
      const isColour = (v) => /#[0-9a-f]{3,8}\b|\brgba?\(/i.test(v);
      return {
        error: null,
        missing: tokens(light).filter(
          (t) => isColour(light.style.getPropertyValue(t)) && !darkSet.has(t)
        )
      };
    });
    notOk(missing.error, `could not find the token blocks: ${missing.error}`);
    deepEq(missing.missing, [], 'colour tokens with no dark value');
  });

  test('no CSS rule outside the token blocks names a colour directly', async () => {
    // A hex inside a rule is a colour that cannot follow the theme. Six of them
    // were hiding in this stylesheet — alert borders, the progress bar, the
    // status dots — and every one of them looked fine to whoever added it.
    const offenders = await app(() => {
      const TOKEN_BLOCKS = [':root', ':root[data-theme="dark"]'];
      const out = [];
      // A rule is checked AND descended into, rather than one or the other:
      // since CSS Nesting shipped, CSSStyleRule inherits `cssRules` too, so
      // treating its presence as "this is an @media" silently skipped every
      // style rule in the sheet and made this whole case vacuous.
      const walk = (rules) => {
        for (const rule of rules) {
          if (rule.style && !TOKEN_BLOCKS.includes(rule.selectorText)) {
            for (const prop of rule.style) {
              const value = rule.style.getPropertyValue(prop);
              // A fully transparent stop has no colour to get wrong — it is the
              // start of .scroll-fade's gradient.
              const literal = value
                .replace(/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/g, '')
                .match(/#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)/i);
              if (literal) out.push(`${rule.selectorText} { ${prop}: ${value} }`);
            }
          }
          if (rule.cssRules && rule.cssRules.length) walk([...rule.cssRules]);
        }
      };
      walk([...document.styleSheets[0].cssRules]);
      return out;
    });
    deepEq(offenders, [], 'CSS rules with a hardcoded colour');
  });

  test('the dark palette actually reaches the page, not just the token block', async () => {
    const r = await app(() => {
      const before = document.documentElement.getAttribute('data-theme');
      const read = () => {
        const s = getComputedStyle(document.body);
        return { bg: s.backgroundColor, fg: s.color };
      };
      document.documentElement.setAttribute('data-theme', 'light');
      const light = read();
      document.documentElement.setAttribute('data-theme', 'dark');
      const dark = read();
      document.documentElement.setAttribute('data-theme', before);
      return { light, dark };
    });
    ok(r.light.bg !== r.dark.bg, `background did not change: ${r.light.bg}`);
    ok(r.light.fg !== r.dark.fg, `text colour did not change: ${r.light.fg}`);

    // And in the right direction — dark must be darker than light, or the
    // tokens have been swapped.
    const lum = (rgb) => {
      const [r_, g, b] = rgb.match(/\d+/g).map(Number);
      return 0.2126 * r_ + 0.7152 * g + 0.0722 * b;
    };
    ok(lum(r.dark.bg) < lum(r.light.bg), 'dark background is darker');
    ok(lum(r.dark.fg) > lum(r.light.fg), 'dark text is lighter');
  });

  /* ---- printing ---------------------------------------------------- */

  test('printing forces light, and restores the theme afterwards', async () => {
    // Browsers drop background colours when printing but keep text colours, so
    // printing in dark mode puts near-white text on white paper — a report that
    // reads as blank. The 🖨 button is a real feature here; so is Ctrl+P.
    const r = await app(() => {
      const beforeMode = localStorage.getItem('promanage_theme');
      localStorage.setItem('promanage_theme', 'dark');
      applyTheme('dark');

      window.dispatchEvent(new Event('beforeprint'));
      const during = document.documentElement.getAttribute('data-theme');
      window.dispatchEvent(new Event('afterprint'));
      const after = document.documentElement.getAttribute('data-theme');

      if (beforeMode === null) localStorage.removeItem('promanage_theme');
      else localStorage.setItem('promanage_theme', beforeMode);
      applyTheme(getThemeMode());
      updateThemeToggle();
      return { during, after };
    });
    eq(r.during, 'light', 'theme while the print layout is generated');
    eq(r.after, 'dark', 'theme restored once the dialog closes');
  });

  /* ---- native widgets ---------------------------------------------- */

  test('color-scheme follows the theme so native controls do too', async () => {
    // Without this the select popup, the date picker and the scrollbars stay
    // light and punch white holes in a dark page — and Chrome draws dark text
    // into the date picker, which makes it unreadable rather than just ugly.
    const r = await app(() => {
      const before = document.documentElement.getAttribute('data-theme');
      const read = () => getComputedStyle(document.documentElement).colorScheme;
      document.documentElement.setAttribute('data-theme', 'light');
      const light = read();
      document.documentElement.setAttribute('data-theme', 'dark');
      const dark = read();
      document.documentElement.setAttribute('data-theme', before);
      return { light, dark };
    });
    eq(r.light, 'light');
    eq(r.dark, 'dark');
  });

  test('the password field is styled like every other input', async () => {
    // It was missing from the input selector list, so it fell through to the
    // browser default — a light box beside the themed email field above it, on
    // the very first screen the app shows.
    const r = await app(() => {
      const before = document.documentElement.getAttribute('data-theme');
      document.documentElement.setAttribute('data-theme', 'dark');
      const pw = getComputedStyle(document.getElementById('login-password'));
      const email = getComputedStyle(document.getElementById('login-email'));
      const out = {
        pwBg: pw.backgroundColor, emailBg: email.backgroundColor,
        pwFg: pw.color, emailFg: email.color
      };
      document.documentElement.setAttribute('data-theme', before);
      return out;
    });
    eq(r.pwBg, r.emailBg, 'password background matches the email field');
    eq(r.pwFg, r.emailFg, 'password text colour matches the email field');
  });
};
