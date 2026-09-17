package db

import (
	"path/filepath"
	"testing"
)

func TestNormalizeUploadedImageURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		raw   string
		want  string
		valid bool
	}{
		{
			name:  "direct file",
			raw:   "/static/uploads/image.jpg",
			want:  "/static/uploads/image.jpg",
			valid: true,
		},
		{
			name:  "trims and strips query fragment",
			raw:   "  /static/uploads/image.png?cache=1#frag  ",
			want:  "/static/uploads/image.png",
			valid: true,
		},
		{
			name:  "reject traversal sample",
			raw:   "/static/uploads/../../internal/db/forum_schema.sql",
			valid: false,
		},
		{
			name:  "reject nested path segment",
			raw:   "/static/uploads/nested/file.jpg",
			valid: false,
		},
		{
			name:  "reject backslash separator",
			raw:   "/static/uploads/..\\..\\forum_schema.sql",
			valid: false,
		},
		{
			name:  "reject dot segment",
			raw:   "/static/uploads/..",
			valid: false,
		},
		{
			name:  "reject empty filename",
			raw:   "/static/uploads/",
			valid: false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			normalized, ok := NormalizeUploadedImageURL(tt.raw)
			if ok != tt.valid {
				t.Fatalf("valid mismatch: got %v want %v (normalized=%q)", ok, tt.valid, normalized)
			}
			if normalized != tt.want {
				t.Fatalf("normalized mismatch: got %q want %q", normalized, tt.want)
			}
		})
	}
}

func TestGetUploadedImageDiskPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		imageURL string
		wantPath string
		valid    bool
	}{
		{
			name:     "direct file",
			imageURL: "/static/uploads/image.jpg",
			wantPath: filepath.Join("web", "static", "uploads", "image.jpg"),
			valid:    true,
		},
		{
			name:     "strips query",
			imageURL: "/static/uploads/image.jpg?cache=1",
			wantPath: filepath.Join("web", "static", "uploads", "image.jpg"),
			valid:    true,
		},
		{
			name:     "reject traversal sample",
			imageURL: "/static/uploads/../../internal/db/forum_schema.sql",
			valid:    false,
		},
		{
			name:     "reject nested path segment",
			imageURL: "/static/uploads/nested/file.jpg",
			valid:    false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			diskPath, ok := GetUploadedImageDiskPath(tt.imageURL)
			if ok != tt.valid {
				t.Fatalf("valid mismatch: got %v want %v (diskPath=%q)", ok, tt.valid, diskPath)
			}
			if diskPath != tt.wantPath {
				t.Fatalf("disk path mismatch: got %q want %q", diskPath, tt.wantPath)
			}
		})
	}
}
