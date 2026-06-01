/** @module CallHandler */
import Env from "./Env";
import GitLogger from "./GitLogger";
import ShortcutFinder from "./ShortcutFinder";
import UrlProcessor from "./UrlProcessor";
import type { EnvLike, RedirectResponse, Shortcut } from "../types";

/** Handle a call. */

export default class CallHandler {
  /**
   * The 'main' function of this class.
   */
  static async handleCall() {
    const targetDomain = document.querySelector<HTMLElement>("#target-domain");
    if (!targetDomain) {
      throw new Error('Missing element "#target-domain".');
    }
    targetDomain.textContent = "";

    const env = new Env({ context: "process" });
    const params = Env.getParamsFromUrl();
    await env.populate(params);
    new GitLogger(env.gitInfo).logVersion();

    if (env.debug) {
      env.logger.showLog();
    }

    let redirectUrl: string;

    const response = this.getRedirectResponse(env);

    if (response.status === "found") {
      redirectUrl = response.redirectUrl as string;
    } else {
      redirectUrl = this.getRedirectUrlToHome(env, response);
    }

    targetDomain.textContent = typeof response.redirectUrl === "string" ? response.redirectUrl : "";

    env.logger.info("Redirect to:   " + redirectUrl);

    if (env.debug) {
      return;
    }

    this.redirect(redirectUrl, env.isRunningStandalone(), true);
  }

  // ── PWA breakout strategy (test harness) ─────────────────────────────────
  // The hard part of issue #329 is forcing a target URL to open OUTSIDE the
  // installed PWA's standalone window — in the real default browser, with an
  // address bar — on Android. Which mechanism actually achieves that depends
  // on the device/Chrome version, and can only be confirmed on a real device.
  //
  // So we keep several strategies and allow selecting one at runtime via
  // `?pwa=<strategy>` (persisted to localStorage), to A/B test on a phone:
  //
  //   intent   – intent:// VIEW+BROWSABLE, NEW_TASK, no package, no fallback.
  //              Forces Android (not Chrome) to resolve the intent, aiming for
  //              the default browser in a fresh task. [default]
  //   chrome   – intent:// targeting com.android.chrome explicitly.
  //   fallback – intent:// + S.browser_fallback_url (Chrome may take the
  //              in-place fallback for browser-only URLs).
  //   window   – window.open(url, "_blank") (Custom Tab on a WebAPK).
  //   href     – plain in-place navigation (control / current "broken" path).
  //
  // Once the winning strategy is confirmed on-device, the others can be removed.
  static readonly DEFAULT_PWA_STRATEGY = "intent";

  /**
   * Read a `?pwa=<strategy>` override from the URL (search or hash) and persist
   * it, so a strategy can be armed once and used across subsequent searches.
   */
  static capturePwaBreakoutOverride() {
    try {
      const search = new URLSearchParams(window.location.search);
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      if (!search.has("pwa") && !hash.has("pwa")) {
        return;
      }
      const value = search.get("pwa") || hash.get("pwa");
      if (value) {
        window.localStorage.setItem("trovuPwaBreakout", value);
      } else {
        // `?pwa=` with no value clears the override (back to default).
        window.localStorage.removeItem("trovuPwaBreakout");
      }
    } catch {
      // localStorage / URL access can throw in restricted contexts; ignore.
    }
  }

  static getPwaBreakoutStrategy(): string {
    try {
      return window.localStorage.getItem("trovuPwaBreakout") || this.DEFAULT_PWA_STRATEGY;
    } catch {
      return this.DEFAULT_PWA_STRATEGY;
    }
  }

  /** Set (or, with an empty value, clear) the PWA breakout strategy override. */
  static setPwaBreakoutStrategy(value: string) {
    try {
      if (value) {
        window.localStorage.setItem("trovuPwaBreakout", value);
      } else {
        window.localStorage.removeItem("trovuPwaBreakout");
      }
    } catch {
      // localStorage unavailable; ignore.
    }
  }

  /**
   * Show a small badge with the armed PWA breakout strategy, so it is visible
   * which strategy is being tested on-device. Only shown when an override was
   * explicitly set via `?pwa=`, so normal users never see it.
   */
  static showBreakoutBadge() {
    try {
      if (!window.localStorage.getItem("trovuPwaBreakout")) {
        return;
      }
      if (document.getElementById("pwa-breakout-badge")) {
        return;
      }
      const badge = document.createElement("div");
      badge.id = "pwa-breakout-badge";
      badge.textContent = `PWA breakout: ${this.getPwaBreakoutStrategy()}`;
      badge.title = "Set with ?pwa=intent|chrome|fallback|window|href · clear with ?pwa=";
      badge.style.cssText =
        "position:fixed;left:8px;bottom:8px;z-index:99999;background:#343a40;color:#fff;" +
        "font:12px/1.4 monospace;padding:4px 8px;border-radius:4px;opacity:0.85;";
      document.body.appendChild(badge);
    } catch {
      // DOM/localStorage unavailable; ignore.
    }
  }

  /**
   * Build an Android `intent://` URL for the given target, or null if the
   * target cannot be safely represented as an intent (non-http, or has a
   * fragment — `#` would collide with the intent's own `#Intent` delimiter).
   */
  static buildAndroidIntentUrl(redirectUrl: string, strategy: string): string | null {
    let url: URL;
    try {
      url = new URL(redirectUrl);
    } catch {
      return null;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hash) {
      return null;
    }
    const scheme = url.protocol.slice(0, -1);
    const path = `${url.host}${url.pathname}${url.search}`;
    let intent =
      `intent://${path}#Intent` +
      `;scheme=${scheme}` +
      `;action=android.intent.action.VIEW` +
      `;category=android.intent.category.BROWSABLE` +
      `;launchFlags=0x10000000`;
    if (strategy === "chrome") {
      intent += `;package=com.android.chrome`;
    }
    if (strategy === "fallback") {
      intent += `;S.browser_fallback_url=${encodeURIComponent(redirectUrl)}`;
    }
    intent += `;end;`;
    return intent;
  }

  /**
   * Attempt to open `redirectUrl` OUTSIDE the PWA standalone container.
   * Must be called synchronously within a user gesture so the navigation /
   * window.open is not blocked. Returns true if a breakout was initiated.
   */
  static breakoutFromStandalone(redirectUrl: string): boolean {
    const strategy = this.getPwaBreakoutStrategy();
    const isAndroid = /Android/i.test(window.navigator.userAgent);

    if (strategy === "href") {
      return false; // Control: fall through to normal in-place navigation.
    }

    if (isAndroid && strategy !== "window") {
      const intentUrl = this.buildAndroidIntentUrl(redirectUrl, strategy);
      if (intentUrl) {
        // window.location.href (NOT link.click()): Chrome blocks programmatic
        // clicks on intent:// anchors (synthetic events are isTrusted=false),
        // but honours location.href against the live user-activation state.
        window.location.href = intentUrl;
        return true;
      }
    }

    // iOS / desktop standalone, the "window" strategy, or non-intent-able URLs:
    // open a new window to escape the standalone container.
    try {
      const externalWindow = window.open(redirectUrl, "_blank");
      if (externalWindow) {
        try {
          externalWindow.opener = null;
        } catch {
          // Some browsers disallow setting opener; not fatal.
        }
        return true;
      }
    } catch {
      // Pop-up blocked or window.open unavailable; fall through.
    }

    return false;
  }

  /**
   * Redirect to a target URL, breaking out of the PWA standalone wrapper when
   * running as an installed PWA so the URL opens in the device's browser.
   *
   * @param {string} redirectUrl   - The target URL.
   * @param {boolean} isStandalone - Whether the app is running in PWA standalone mode.
   * @param {boolean} replace      - Whether to use location.replace instead of location.href.
   */
  static redirect(redirectUrl: string, isStandalone: boolean, replace = false) {
    if (isStandalone && this.breakoutFromStandalone(redirectUrl)) {
      return;
    }

    if (replace) {
      window.location.replace(redirectUrl);
    } else {
      window.location.href = redirectUrl;
    }
  }

  /**
   * Given the environment, get a response object, incl. redirect URL.
   *
   * @param {object} env        - The environment.
   *
   * @return {object} response  - Contains redirect URL, status.
   */
  static getRedirectResponse(env: EnvLike): RedirectResponse {
    if (env.reload && !env.query) {
      return { status: "reloaded" };
    }

    if (!env.query) {
      return { status: "not_found", redirectUrl: false };
    }

    const shortcut = ShortcutFinder.findShortcut(env);

    if (!shortcut) {
      return { status: "not_found" };
    }

    if (shortcut.deprecated) {
      return {
        status: "deprecated",
        alternative: this.getAlternative(shortcut, env),
      };
    }

    if (shortcut.removed) {
      return {
        status: "removed",
        key: shortcut.key,
      };
    }

    if (!shortcut.reachable) {
      return {
        status: "not_reachable",
        namespace: shortcut.namespace,
      };
    }

    let redirectUrl = shortcut.url || "";

    env.logger.info("Used template: " + redirectUrl);

    redirectUrl = UrlProcessor.replaceVariables(redirectUrl, {
      language: env.language,
      country: env.country,
    });
    redirectUrl = UrlProcessor.replaceArguments(redirectUrl, env.args, env);

    if (!this.isSafeRedirectUrl(redirectUrl)) {
      return {
        status: "suspicious",
        redirectUrl,
      };
    }

    return {
      status: "found",
      redirectUrl,
    };
  }

  static getAlternative(shortcut: Shortcut, env: Pick<EnvLike, "args">): string {
    let alternative = shortcut.deprecated.alternative.query;
    for (const i in env.args) {
      alternative = alternative.replace("<" + (parseInt(i) + 1) + ">", env.args[i]);
    }
    return alternative;
  }

  static isSafeRedirectUrl(redirectUrl: string): boolean {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(redirectUrl);
    } catch {
      return false;
    }
    return ["http:", "https:", "mailto:"].includes(parsedUrl.protocol);
  }

  /**
   * Redirect in case a shortcut was not found.
   *
   * @param {string} status       - The status of the call.
   *
   * @return {string} redirectUrl - Redirect URL to the homepage, with parameters.
   */
  static getRedirectUrlToHome(env: Pick<Env, "buildUrlParamStr">, response: RedirectResponse): string {
    const params = Env.getParamsFromUrl();
    delete params.query;
    for (const property of ["alternative", "key", "namespace", "status"]) {
      if (response[property]) {
        params[property] = response[property];
      }
    }
    const paramStr = env.buildUrlParamStr(params);
    const redirectUrl = "../index.html#" + paramStr;
    return redirectUrl;
  }
}
