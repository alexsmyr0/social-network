package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAPIPostsCreate_TextOnly_NoImageURL(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Text only post",
		"body":         "Just text content",
		"category_ids": []int64{1},
	})

	post := getPost(t, h, token, postID)
	if v, ok := post["image_url"]; ok && v != nil {
		t.Fatalf("expected image_url to be nil/absent for text-only post, got %v", v)
	}
}

func TestAPIPostsCreate_MultipartImageOnly_SupportedTypes(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	cases := []struct {
		name     string
		filename string
		content  []byte
	}{
		{name: "jpeg", filename: "image.jpg", content: sampleJPEGBytes},
		{name: "png", filename: "image.png", content: samplePNGBytes},
		{name: "gif", filename: "image.gif", content: sampleGIFBytes},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			rec := multipartRequest(
				t,
				h,
				http.MethodPost,
				"/api/v1/posts",
				token,
				map[string]string{
					"title": "Image only " + tc.name,
					"body":  "",
				},
				[]int64{1},
				tc.filename,
				tc.content,
			)
			if rec.Code != http.StatusCreated {
				t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
			}

			post := decodeEnvelopeDataMap(t, rec)
			rawURL, ok := post["image_url"]
			if !ok || rawURL == nil {
				t.Fatalf("expected image_url in create response, got post=%v", post)
			}
			imageURL, ok := rawURL.(string)
			if !ok || strings.TrimSpace(imageURL) == "" {
				t.Fatalf("expected non-empty image_url string, got %T(%v)", rawURL, rawURL)
			}
			t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })

			rawID, ok := post["id"]
			if !ok {
				t.Fatalf("missing id in create response: %v", post)
			}
			postID := int64(rawID.(float64))
			got := getPost(t, h, token, postID)

			if got["body"] != "" {
				t.Fatalf("expected empty body for image-only post, got %v", got["body"])
			}
			gotURL, ok := got["image_url"].(string)
			if !ok || gotURL == "" {
				t.Fatalf("expected image_url in fetched post, got %v", got["image_url"])
			}
		})
	}
}

func TestAPIPostsCreate_MultipartRejectsUnsupportedImageType(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	rec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts",
		token,
		map[string]string{
			"title": "Bad image",
			"body":  "Body with unsupported image",
		},
		[]int64{1},
		"image.png",
		sampleTextBytes,
	)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, rec)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got body=%s", rec.Body.String())
	}
	if !strings.HasPrefix(apiErr.Message, "unsupported image type") {
		t.Fatalf("expected unsupported image type message prefix, got %q", apiErr.Message)
	}
}

func TestAPIPostsCreate_MultipartAllowsExtensionMimeMismatchWhenDetectedTypeSupported(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	rec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts",
		token,
		map[string]string{
			"title": "Mismatched file type",
			"body":  "Body",
		},
		[]int64{1},
		"image.jpg",
		samplePNGBytes,
	)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	post := decodeEnvelopeDataMap(t, rec)
	rawURL, ok := post["image_url"]
	if !ok || rawURL == nil {
		t.Fatalf("expected image_url in create response, got post=%v", post)
	}
	imageURL, ok := rawURL.(string)
	if !ok || strings.TrimSpace(imageURL) == "" {
		t.Fatalf("expected non-empty image_url string, got %T(%v)", rawURL, rawURL)
	}
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })
	if !strings.HasSuffix(strings.ToLower(imageURL), ".png") {
		t.Fatalf("expected uploaded image extension to match detected PNG type, got %q", imageURL)
	}
}

func TestAPIPostsImageURLVisibleInPublicMyAndLikedLists(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	// image post
	imageRec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts",
		token,
		map[string]string{
			"title": "Image list post",
			"body":  "",
		},
		[]int64{1},
		"list.jpg",
		sampleJPEGBytes,
	)
	if imageRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", imageRec.Code, imageRec.Body.String())
	}
	imagePost := decodeEnvelopeDataMap(t, imageRec)
	imageID := int64(imagePost["id"].(float64))
	imageURL := imagePost["image_url"].(string)
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })

	// text-only post
	textID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Text list post",
		"body":         "Text body",
		"category_ids": []int64{1},
	})

	// like image post so it appears in liked list
	likeReq := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/like", imageID), nil)
	likeReq.Header.Set("Cookie", "session_token="+token)
	likeRec := httptest.NewRecorder()
	h.ServeHTTP(likeRec, likeReq)
	if likeRec.Code != http.StatusOK {
		t.Fatalf("expected 200 when liking image post, got %d body=%s", likeRec.Code, likeRec.Body.String())
	}

	checkList := func(path string, withCookie bool) []map[string]any {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if withCookie {
			req.Header.Set("Cookie", "session_token="+token)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s expected 200, got %d body=%s", path, rec.Code, rec.Body.String())
		}

		var env apiEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("%s unmarshal envelope: %v", path, err)
		}
		if env.Error != nil {
			t.Fatalf("%s unexpected error: %+v", path, env.Error)
		}

		var posts []map[string]any
		if err := json.Unmarshal(env.Data, &posts); err != nil {
			t.Fatalf("%s unmarshal posts: %v", path, err)
		}
		return posts
	}

	homePosts := checkList("/api/v1/posts?page=1&per_page=50", true)
	imageHome, ok := findPostByID(homePosts, imageID)
	if !ok {
		t.Fatalf("image post %d not found in home list", imageID)
	}
	if _, ok := imageHome["image_url"].(string); !ok {
		t.Fatalf("expected image_url string in home list image post, got %v", imageHome["image_url"])
	}
	textHome, ok := findPostByID(homePosts, textID)
	if !ok {
		t.Fatalf("text post %d not found in home list", textID)
	}
	if v, ok := textHome["image_url"]; ok && v != nil {
		t.Fatalf("expected nil image_url for text post in home list, got %v", v)
	}

	myPosts := checkList("/api/v1/posts/mine?page=1&per_page=50", true)
	imageMine, ok := findPostByID(myPosts, imageID)
	if !ok {
		t.Fatalf("image post %d not found in my posts", imageID)
	}
	if _, ok := imageMine["image_url"].(string); !ok {
		t.Fatalf("expected image_url string in my posts image entry, got %v", imageMine["image_url"])
	}

	likedPosts := checkList("/api/v1/posts/liked?page=1&per_page=50", true)
	imageLiked, ok := findPostByID(likedPosts, imageID)
	if !ok {
		t.Fatalf("image post %d not found in liked posts", imageID)
	}
	if _, ok := imageLiked["image_url"].(string); !ok {
		t.Fatalf("expected image_url string in liked posts image entry, got %v", imageLiked["image_url"])
	}
}

func TestAPIPostsCreate_MultipartUploadSizeBoundary(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	fields := map[string]string{
		"title": "Boundary upload post",
		"body":  "",
	}
	categoryIDs := []int64{1}
	filename := "boundary.jpg"

	basePayload, _ := buildPostMultipartBody(t, fields, categoryIDs, filename, []byte{})
	atLimitFileSize := maxUploadBytes - len(basePayload)
	if atLimitFileSize < len(sampleJPEGBytes) {
		t.Fatalf("computed file size at limit too small: %d", atLimitFileSize)
	}

	atLimitPayload, atLimitContentType := buildPostMultipartBody(
		t,
		fields,
		categoryIDs,
		filename,
		jpegBytesOfSize(t, atLimitFileSize),
	)
	if got := len(atLimitPayload); got != maxUploadBytes {
		t.Fatalf("expected exact payload size %d bytes, got %d", maxUploadBytes, got)
	}

	recAtLimit := multipartRequestWithBody(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts",
		token,
		atLimitContentType,
		atLimitPayload,
	)
	if recAtLimit.Code != http.StatusCreated {
		t.Fatalf("expected 201 at size limit, got %d body=%s", recAtLimit.Code, recAtLimit.Body.String())
	}

	post := decodeEnvelopeDataMap(t, recAtLimit)
	rawURL, ok := post["image_url"]
	if !ok || rawURL == nil {
		t.Fatalf("expected image_url for at-limit upload, got post=%v", post)
	}
	imageURL, ok := rawURL.(string)
	if !ok || strings.TrimSpace(imageURL) == "" {
		t.Fatalf("expected non-empty image_url string, got %T(%v)", rawURL, rawURL)
	}
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })

	overLimitPayload, overLimitContentType := buildPostMultipartBody(
		t,
		fields,
		categoryIDs,
		filename,
		jpegBytesOfSize(t, atLimitFileSize+1),
	)
	if got := len(overLimitPayload); got != maxUploadBytes+1 {
		t.Fatalf("expected over-limit payload size %d bytes, got %d", maxUploadBytes+1, got)
	}

	recOverLimit := multipartRequestWithBody(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts",
		token,
		overLimitContentType,
		overLimitPayload,
	)
	if recOverLimit.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 over size limit, got %d body=%s", recOverLimit.Code, recOverLimit.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, recOverLimit)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got body=%s", recOverLimit.Body.String())
	}
	if apiErr.Code != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("expected PAYLOAD_TOO_LARGE, got %q", apiErr.Code)
	}
	if apiErr.Message != "upload too large" {
		t.Fatalf("expected message %q, got %q", "upload too large", apiErr.Message)
	}
}

func TestAPICommentsCreate_MultipartImage_IncludedInCommentPayloads(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post for image comments",
		"body":         "seed body",
		"category_ids": []int64{1},
	})

	cases := []struct {
		name     string
		filename string
		content  []byte
		wantExt  string
	}{
		{name: "jpeg", filename: "comment.jpg", content: sampleJPEGBytes, wantExt: ".jpg"},
		{name: "png", filename: "comment.png", content: samplePNGBytes, wantExt: ".png"},
		{name: "gif", filename: "comment.gif", content: sampleGIFBytes, wantExt: ".gif"},
	}

	commentImageURLs := make([]string, 0, len(cases))

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			rec := multipartCommentRequest(
				t,
				h,
				token,
				postID,
				map[string]string{
					"body": "Comment with image " + tc.name,
				},
				tc.filename,
				tc.content,
			)
			if rec.Code != http.StatusCreated {
				t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
			}

			comment := decodeEnvelopeDataMap(t, rec)
			rawURL, ok := comment["image_url"]
			if !ok || rawURL == nil {
				t.Fatalf("expected image_url in create comment response, got %v", comment)
			}
			commentImageURL, ok := rawURL.(string)
			if !ok || strings.TrimSpace(commentImageURL) == "" {
				t.Fatalf("expected non-empty image_url string, got %T(%v)", rawURL, rawURL)
			}
			if !strings.HasSuffix(strings.ToLower(commentImageURL), tc.wantExt) {
				t.Fatalf("expected comment image extension %q, got %q", tc.wantExt, commentImageURL)
			}
			commentImageURLs = append(commentImageURLs, commentImageURL)
			t.Cleanup(func() { cleanupUploadedFromImageURL(t, commentImageURL) })
		})
	}

	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/comments", postID), nil)
	req.Header.Set("Cookie", "session_token="+token)
	recList := httptest.NewRecorder()
	h.ServeHTTP(recList, req)
	if recList.Code != http.StatusOK {
		t.Fatalf("expected 200 listing comments, got %d body=%s", recList.Code, recList.Body.String())
	}

	var env apiEnvelope
	if err := json.Unmarshal(recList.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal comments envelope: %v body=%s", err, recList.Body.String())
	}
	if env.Error != nil {
		t.Fatalf("unexpected list comments error: %+v", env.Error)
	}

	var comments []map[string]any
	if err := json.Unmarshal(env.Data, &comments); err != nil {
		t.Fatalf("unmarshal comments payload: %v", err)
	}

	for _, wantURL := range commentImageURLs {
		found := false
		for _, c := range comments {
			if c["image_url"] == wantURL {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected created image_url %q in comments list payload %v", wantURL, comments)
		}
	}
}

func TestAPICommentsCreate_MultipartImageOnly_AllowsEmptyBody(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post for image-only comments",
		"body":         "seed body",
		"category_ids": []int64{1},
	})

	cases := []struct {
		name     string
		filename string
		content  []byte
		wantExt  string
	}{
		{name: "jpeg", filename: "comment.jpg", content: sampleJPEGBytes, wantExt: ".jpg"},
		{name: "png", filename: "comment.png", content: samplePNGBytes, wantExt: ".png"},
		{name: "gif", filename: "comment.gif", content: sampleGIFBytes, wantExt: ".gif"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			rec := multipartCommentRequest(
				t,
				h,
				token,
				postID,
				map[string]string{},
				tc.filename,
				tc.content,
			)
			if rec.Code != http.StatusCreated {
				t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
			}

			comment := decodeEnvelopeDataMap(t, rec)
			rawBody, ok := comment["body"]
			if !ok {
				t.Fatalf("expected body field in response, got %v", comment)
			}
			if bodyStr, ok := rawBody.(string); !ok || bodyStr != "" {
				t.Fatalf("expected empty body string for image-only comment, got %T(%v)", rawBody, rawBody)
			}
			rawURL, ok := comment["image_url"]
			if !ok || rawURL == nil {
				t.Fatalf("expected image_url in create comment response, got %v", comment)
			}
			commentImageURL, ok := rawURL.(string)
			if !ok || strings.TrimSpace(commentImageURL) == "" {
				t.Fatalf("expected non-empty image_url string, got %T(%v)", rawURL, rawURL)
			}
			if !strings.HasSuffix(strings.ToLower(commentImageURL), tc.wantExt) {
				t.Fatalf("expected comment image extension %q, got %q", tc.wantExt, commentImageURL)
			}
			t.Cleanup(func() { cleanupUploadedFromImageURL(t, commentImageURL) })
		})
	}
}

func TestAPICommentsCreate_MultipartRejectsUnsupportedImageType(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post for invalid comment image",
		"body":         "seed body",
		"category_ids": []int64{1},
	})

	rec := multipartCommentRequest(
		t,
		h,
		token,
		postID,
		map[string]string{
			"body": "Comment with invalid image",
		},
		"comment.png",
		sampleTextBytes,
	)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, rec)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got body=%s", rec.Body.String())
	}
	if !strings.HasPrefix(apiErr.Message, "unsupported image type") {
		t.Fatalf("expected unsupported image type message prefix, got %q", apiErr.Message)
	}
}

func TestAPICommentsCreate_MultipartUploadSizeBoundary(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post for comment upload boundary",
		"body":         "seed body",
		"category_ids": []int64{1},
	})

	fields := map[string]string{
		"body": "",
	}
	filename := "comment-boundary.jpg"
	path := fmt.Sprintf("/api/v1/posts/%d/comments", postID)

	basePayload, _ := buildCommentMultipartBody(t, fields, filename, []byte{})
	atLimitFileSize := maxUploadBytes - len(basePayload)
	if atLimitFileSize < len(sampleJPEGBytes) {
		t.Fatalf("computed file size at limit too small: %d", atLimitFileSize)
	}

	atLimitPayload, atLimitContentType := buildCommentMultipartBody(
		t,
		fields,
		filename,
		jpegBytesOfSize(t, atLimitFileSize),
	)
	if got := len(atLimitPayload); got != maxUploadBytes {
		t.Fatalf("expected exact payload size %d bytes, got %d", maxUploadBytes, got)
	}

	recAtLimit := multipartRequestWithBody(
		t,
		h,
		http.MethodPost,
		path,
		token,
		atLimitContentType,
		atLimitPayload,
	)
	if recAtLimit.Code != http.StatusCreated {
		t.Fatalf("expected 201 at size limit, got %d body=%s", recAtLimit.Code, recAtLimit.Body.String())
	}

	comment := decodeEnvelopeDataMap(t, recAtLimit)
	rawURL, ok := comment["image_url"]
	if !ok || rawURL == nil {
		t.Fatalf("expected image_url for at-limit comment upload, got comment=%v", comment)
	}
	imageURL, ok := rawURL.(string)
	if !ok || strings.TrimSpace(imageURL) == "" {
		t.Fatalf("expected non-empty image_url string, got %T(%v)", rawURL, rawURL)
	}
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })

	overLimitPayload, overLimitContentType := buildCommentMultipartBody(
		t,
		fields,
		filename,
		jpegBytesOfSize(t, atLimitFileSize+1),
	)
	if got := len(overLimitPayload); got != maxUploadBytes+1 {
		t.Fatalf("expected over-limit payload size %d bytes, got %d", maxUploadBytes+1, got)
	}

	recOverLimit := multipartRequestWithBody(
		t,
		h,
		http.MethodPost,
		path,
		token,
		overLimitContentType,
		overLimitPayload,
	)
	if recOverLimit.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 over size limit, got %d body=%s", recOverLimit.Code, recOverLimit.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, recOverLimit)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got body=%s", recOverLimit.Body.String())
	}
	if apiErr.Code != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("expected PAYLOAD_TOO_LARGE, got %q", apiErr.Code)
	}
	if apiErr.Message != "upload too large" {
		t.Fatalf("expected message %q, got %q", "upload too large", apiErr.Message)
	}
}
