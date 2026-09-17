package handlers

import (
	"context"
	"testing"
)

func TestMaybeDeleteUploadedImageByURL_RejectsTraversalInputs(t *testing.T) {
	t.Parallel()

	traversalInputs := []string{
		"/static/uploads/../../internal/db/forum_schema.sql",
		"/static/uploads/nested/file.jpg",
		"/static/uploads/..\\..\\forum_schema.sql",
	}

	for _, input := range traversalInputs {
		input := input
		t.Run(input, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("unexpected panic for %q: %v", input, r)
				}
			}()

			if err := maybeDeleteUploadedImageByURL(context.Background(), nil, input); err != nil {
				t.Fatalf("expected nil error for rejected input %q, got %v", input, err)
			}
		})
	}
}
