// SPDX-License-Identifier: AGPL-3.0-or-later

// Package frontend embeds the built web UI (frontend/dist) for the server build.
package frontend

import "embed"

// Dist holds dist/ (run `pnpm build` first).
//
//go:embed all:dist
var Dist embed.FS
