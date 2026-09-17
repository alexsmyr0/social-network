package main

import (
	"strconv"
	"strings"
)

func parseRouteID(path string, allowedRoutes ...string) (int64, bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) != 2 {
		return 0, false
	}

	if !routeIsAllowed(parts[0], allowedRoutes) {
		return 0, false
	}

	id, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}

	return id, true
}

func routeIsAllowed(route string, allowedRoutes []string) bool {
	for _, allowed := range allowedRoutes {
		if route == allowed {
			return true
		}
	}
	return false
}
