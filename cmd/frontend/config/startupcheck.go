// cmd/frontend/config/startupcheck.go
package config

import "forum/web/startupcheck"

func StartupCheckConfig() startupcheck.Config {
	return startupcheck.Config{
		WebRoot: ".",

		CriticalHTML: []string{
			"SPA/index.html",
			"web/errors/error.html",
		},

		JSDirs: []string{
			"SPA",
		},

		CriticalCSS: []string{
			"SPA/assets/css/main.css",
			"web/errors/common.css",
		},

		MinJSFiles:   1, // main.js
		ExactJSFiles: 0, // disabled
	}
}

// HELPER
func ValidateFrontendStartup() error {
	return startupcheck.ValidateFiles(StartupCheckConfig())
}
