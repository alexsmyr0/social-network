// cmd/frontend/config/startupcheck.go
package config

import (
	"fmt"
	"path/filepath"

	"forum/web/startupcheck"
)

func StartupCheckConfig() startupcheck.Config {
	return startupcheck.Config{
		WebRoot: ".",

		CriticalHTML: []string{
			"SPA/dist/index.html",
			"web/errors/error.html",
		},

		JSDirs: []string{
			"SPA/dist/assets",
		},

		CriticalCSS: []string{
			"web/errors/common.css",
		},

		MinJSFiles:   1, // Vite application bundle
		ExactJSFiles: 0, // disabled
	}
}

func ValidateFrontendStartup() error {
	if err := startupcheck.ValidateFiles(StartupCheckConfig()); err != nil {
		return fmt.Errorf("frontend build is missing or invalid; run `bun run build`: %w", err)
	}

	styles, err := filepath.Glob("SPA/dist/assets/*.css")
	if err != nil || len(styles) == 0 {
		return fmt.Errorf("frontend build has no CSS bundle; run `bun run build`")
	}

	return nil
}
