// web/startupcheck/startupcheck.go
package startupcheck

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	WebRoot string

	CriticalHTML []string
	CriticalCSS  []string

	JSDirs []string

	MinJSFiles int

	ExactJSFiles int
}

func ValidateFiles(cfg Config) error {
	htmlCount, err := countHTMLFiles(cfg)
	if err != nil {
		return err
	}
	jsCount, err := countJSFiles(cfg)
	if err != nil {
		return err
	}
	cssCount, err := countCSSFiles(cfg)
	if err != nil {
		return err
	}

	//Enforce JS count rules if configured
	if cfg.ExactJSFiles > 0 && jsCount != cfg.ExactJSFiles {
		return fmt.Errorf("startupcheck: expected %d JS files, found %d", cfg.ExactJSFiles, jsCount)
	}
	if cfg.MinJSFiles > 0 && jsCount < cfg.MinJSFiles {
		return fmt.Errorf("startupcheck: expected at least %d JS files, found %d", cfg.MinJSFiles, jsCount)
	}

	//Enforce HTML count rules if configured
	if len(cfg.CriticalHTML) > 0 && htmlCount != len(cfg.CriticalHTML) {
		return fmt.Errorf("startupcheck: expected %d critical HTML files, found %d", len(cfg.CriticalHTML), htmlCount)
	}
	//Enforce CSS critical files
	if len(cfg.CriticalCSS) > 0 && cssCount != len(cfg.CriticalCSS) {
		return fmt.Errorf("startupcheck: expected %d critical CSS files, found %d",
			len(cfg.CriticalCSS), cssCount)
	}

	return nil
}

func countHTMLFiles(cfg Config) (int, error) {
	if cfg.WebRoot == "" {
		return 0, errors.New("startupcheck: webroot not set")
	}
	count := 0
	for _, rel := range cfg.CriticalHTML {
		p := rel

		if !filepath.IsAbs(p) {
			p = filepath.Join(cfg.WebRoot, rel)
		}
		if err := mustBeRegularFile(p); err != nil {
			return count, fmt.Errorf("startupcheck: critical HTML check failed for %q: %w", rel, err)
		}
		count++
	}
	return count, nil
}

func countJSFiles(cfg Config) (int, error) {
	if cfg.WebRoot == "" {
		return 0, errors.New("startupcheck: webroot not set")
	}
	count := 0
	for _, dirRel := range cfg.JSDirs {
		dir := dirRel
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(cfg.WebRoot, dirRel)
		}
		if err := mustBeDir(dir); err != nil {
			return count, fmt.Errorf("startupcheck: JS dir %q invalid: %w", dirRel, err)
		}
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}

			if d.Type()&os.ModeSymlink != 0 {
				return nil
			}

			if d.IsDir() {
				return nil
			}

			if strings.HasSuffix(strings.ToLower(d.Name()), ".js") {
				count++
			}
			return nil
		})
		if err != nil {
			return count, fmt.Errorf("startupcheck: walking %q failed: %w", dirRel, err)
		}
	}
	return count, nil
}

func countCSSFiles(cfg Config) (int, error) {
	if cfg.WebRoot == "" {
		return 0, errors.New("startupcheck: webroot not set")
	}

	count := 0
	for _, rel := range cfg.CriticalCSS {
		p := rel
		if !filepath.IsAbs(p) {
			p = filepath.Join(cfg.WebRoot, rel)
		}
		if err := mustBeRegularFile(p); err != nil {
			return count, fmt.Errorf("startupcheck: critical CSS check failed for %q: %w", rel, err)
		}
		count++
	}
	return count, nil
}

func mustBeRegularFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file (%s)", info.Mode())
	}
	return nil
}

func mustBeDir(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("not a directory (%s)", info.Mode())
	}
	return nil
}
