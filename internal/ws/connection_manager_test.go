// internal/ws/connection_manager_test.go
//
// Direct unit tests for the Hub helpers that are not exercised through the
// integration test surface. These cover the dead-coverage methods left over
// from C01/C04 (SetCallbacks, GetOnlineUserIDs, GetConnectionCount) so the
// public Hub API has a documented behavioural contract.
package ws

import (
	"sync"
	"testing"
)

func TestGetOnlineUserIDs_EmptyHub(t *testing.T) {
	h := NewHub()
	if got := h.GetOnlineUserIDs(); len(got) != 0 {
		t.Errorf("expected no online users, got %v", got)
	}
}

func TestGetOnlineUserIDs_ReflectsAddAndRemove(t *testing.T) {
	h := NewHub()

	// Add two distinct users; expect both ids back.
	c1, _ := h.Add(1, nil)
	c2, _ := h.Add(2, nil)

	ids := h.GetOnlineUserIDs()
	if len(ids) != 2 {
		t.Fatalf("expected 2 online users, got %d (%v)", len(ids), ids)
	}
	seen := map[int64]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	if !seen[1] || !seen[2] {
		t.Errorf("expected ids {1,2}, got %v", ids)
	}

	// After both Remove calls the hub must be empty — proves the user-entry
	// cleanup happens on last-disconnect (the doc-comment contract).
	h.Remove(1, c1)
	h.Remove(2, c2)
	if got := h.GetOnlineUserIDs(); len(got) != 0 {
		t.Errorf("expected hub empty after removing all, got %v", got)
	}
}

func TestGetConnectionCount(t *testing.T) {
	h := NewHub()

	if n := h.GetConnectionCount(42); n != 0 {
		t.Errorf("expected 0 for unknown user, got %d", n)
	}

	c1, first1 := h.Add(42, nil)
	if !first1 {
		t.Error("first Add should report firstConnection=true")
	}
	if n := h.GetConnectionCount(42); n != 1 {
		t.Errorf("expected 1 after first Add, got %d", n)
	}

	c2, first2 := h.Add(42, nil)
	if first2 {
		t.Error("second Add for same user should report firstConnection=false")
	}
	if n := h.GetConnectionCount(42); n != 2 {
		t.Errorf("expected 2 after second Add, got %d", n)
	}

	if rem := h.Remove(42, c1); rem != 1 {
		t.Errorf("Remove of first tab should leave 1, got %d", rem)
	}
	if n := h.GetConnectionCount(42); n != 1 {
		t.Errorf("expected 1 after first Remove, got %d", n)
	}

	if rem := h.Remove(42, c2); rem != 0 {
		t.Errorf("Remove of last tab should leave 0, got %d", rem)
	}
	if n := h.GetConnectionCount(42); n != 0 {
		t.Errorf("expected 0 after last Remove, got %d", n)
	}
}

func TestSetCallbacks_FireOnFirstAndLast(t *testing.T) {
	h := NewHub()

	var connectCalls, disconnectCalls []int64
	h.SetCallbacks(
		func(uid int64) { connectCalls = append(connectCalls, uid) },
		func(uid int64) { disconnectCalls = append(disconnectCalls, uid) },
	)

	// First connection for user 7 → onConnect fires.
	c1, _ := h.Add(7, nil)
	// Second connection for user 7 → onConnect must NOT fire again.
	c2, _ := h.Add(7, nil)

	if got, want := connectCalls, []int64{7}; !sliceEq(got, want) {
		t.Errorf("onConnect: got %v want %v", got, want)
	}

	// Remove the first tab → still one connection left → no onDisconnect.
	h.Remove(7, c1)
	if len(disconnectCalls) != 0 {
		t.Errorf("onDisconnect fired too early: %v", disconnectCalls)
	}

	// Remove the last tab → onDisconnect fires.
	h.Remove(7, c2)
	if got, want := disconnectCalls, []int64{7}; !sliceEq(got, want) {
		t.Errorf("onDisconnect: got %v want %v", got, want)
	}
}

func TestSetCallbacks_NilSafe(t *testing.T) {
	// Hubs without callbacks must not panic on Add/Remove.
	h := NewHub()
	c, _ := h.Add(1, nil)
	h.Remove(1, c)
}

// TestConcurrentAddRemove hammers Add/Remove from many goroutines against a
// single Hub and then asserts the Hub settles back to empty. It is meaningless
// without -race: the presence map (connections) is the exact data structure the
// unit-level suite otherwise never touches concurrently.
func TestConcurrentAddRemove(t *testing.T) {
	const users = 32
	const opsPerUser = 200

	h := NewHub()

	start := make(chan struct{})
	var wg sync.WaitGroup

	for u := 0; u < users; u++ {
		uid := int64(u + 1)
		for i := 0; i < opsPerUser; i++ {
			wg.Add(1)
			go func(id int64) {
				defer wg.Done()
				<-start
				c, _ := h.Add(id, nil)
				h.Remove(id, c)
			}(uid)
		}
	}

	close(start)
	wg.Wait()

	if got := h.GetOnlineUserIDs(); len(got) != 0 {
		t.Errorf("hub leaked %d users after concurrent Add/Remove: %v", len(got), got)
	}
}

func sliceEq(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
