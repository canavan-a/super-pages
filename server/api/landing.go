package api

import (
	"html/template"
	"net/http"
	"path/filepath"

	"github.com/gin-gonic/gin"

	"main/proto"
)

// landing is what a share link (/s/<id>#<secret>) opens in a browser. When
// this server also serves the web app, the app itself handles the link.
// Otherwise this page hands the link to the Android app. Either way the
// secret after '#' never reaches the server.
func (a *API) landing(c *gin.Context) {
	id := c.Param("id")
	if !proto.IsID(id) {
		c.String(http.StatusNotFound, "not found")
		return
	}
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("Cache-Control", "no-store")
	if a.cfg.StaticDir != "" {
		c.File(filepath.Join(a.cfg.StaticDir, "index.html"))
		return
	}
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
	_ = landingTmpl.Execute(c.Writer, gin.H{"ID": id})
}

var landingTmpl = template.Must(template.New("landing").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Super Pages</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d1117; color:#e6edf3; font:15px/1.5 system-ui, sans-serif; }
  main { max-width:420px; padding:24px; text-align:center; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#8b949e; margin:0 0 20px; }
  a.btn, button { display:block; width:100%; box-sizing:border-box; padding:12px; border-radius:10px;
         border:1px solid #30363d; background:#2f81f7; color:#fff; font:600 15px system-ui;
         text-decoration:none; margin-bottom:10px; cursor:pointer; }
  button { background:#161b22; color:#e6edf3; }
  #err { color:#f85149; }
</style></head>
<body><main>
  <h1>A page was shared with you</h1>
  <p>Open this link in the Super Pages app. The page's key is in this link; this server never sees it.</p>
  <a class="btn" id="open" href="#">Open in Super Pages</a>
  <button id="copy" type="button">Copy link</button>
  <p id="err"></p>
</main>
<script>
(function () {
  var id = {{.ID}};
  var secret = location.hash.slice(1);
  if (!secret) {
    document.getElementById('err').textContent = 'This link is incomplete: the part after # is missing.';
    return;
  }
  var q = 's=' + encodeURIComponent(location.origin) + '&l=' + encodeURIComponent(id) + '&k=' + encodeURIComponent(secret);
  var isAndroid = /Android/i.test(navigator.userAgent);
  document.getElementById('open').href = isAndroid
    ? 'intent://share?' + q + '#Intent;scheme=superpages;package=com.superpagesapp;end'
    : 'superpages://share?' + q;
  document.getElementById('copy').onclick = function () {
    navigator.clipboard.writeText(location.href).then(function () {
      document.getElementById('copy').textContent = 'Copied';
    });
  };
})();
</script>
</body></html>`))

func (a *API) assetLinks(c *gin.Context) {
	if len(a.cfg.AndroidCertSHA256) == 0 {
		c.JSON(http.StatusOK, []any{})
		return
	}
	c.JSON(http.StatusOK, []gin.H{{
		"relation": []string{"delegate_permission/common.handle_all_urls"},
		"target": gin.H{
			"namespace":                "android_app",
			"package_name":             "com.superpagesapp",
			"sha256_cert_fingerprints": a.cfg.AndroidCertSHA256,
		},
	}})
}
