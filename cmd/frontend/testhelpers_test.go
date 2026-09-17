package main

import (
	"net"
	"testing"
)

func requireLocalTCPListener(t *testing.T) {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("skipping listener-dependent test: local TCP listeners unavailable: %v", err)
		return
	}

	_ = listener.Close()
}
