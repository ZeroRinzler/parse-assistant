// Wowhead tooltip configuration. Kept in its own static file (instead of an inline
// <script> in index.html) so the Content-Security-Policy script-src can stay
// 'self' https://wow.zamimg.com without needing 'unsafe-inline'. This must load
// before https://wow.zamimg.com/js/tooltips.js so the global is set when it runs.
var whTooltips = { colorLinks: true, iconSize: 'small', renameLinks: false };
