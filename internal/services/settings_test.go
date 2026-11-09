// SPDX-License-Identifier: AGPL-3.0-or-later

package services

import (
	"testing"

	"github.com/shuake/aio/internal/core"
	"github.com/shuake/aio/internal/store"
)

func newApp(t *testing.T) *AppService {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	m := core.NewManager(st, dir, func(string, any) {}, nil)
	t.Cleanup(func() { m.Shutdown(); st.Close() })
	return &AppService{M: m}
}

func TestAISettingsDefaults(t *testing.T) {
	a := newApp(t)
	s := a.M.Settings()
	if s.AIProvider != "deepseek" || s.AIModel != "deepseek-flash" || s.AIThinking != "low" || s.AIHasKey {
		t.Fatalf("defaults: %+v", s)
	}
}

func TestAISettingsLegacySwitchFirst(t *testing.T) {
	a := newApp(t)
	_ = a.M.Store.SetSetting("settings", map[string]any{"aiBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "aiModel": "qwen-plus"})
	_ = a.M.Store.SetSecretSetting("ai_api_key", "sk-ali")
	s := a.M.Settings()
	s.AIProvider, s.AIBaseURL, s.AIModel = "deepseek", "", ""
	if _, err := a.SaveSettings(s, "", false); err != nil {
		t.Fatal(err)
	}
	if a.M.AIKey("aliyun") != "sk-ali" || a.M.AIKey("deepseek") != "" || a.M.AIKey("custom") != "" {
		t.Fatalf("status: %v", a.AIKeyStatus())
	}
}

func TestAISettingsLegacyUpgrade(t *testing.T) {
	a := newApp(t)
	// what a version without providers stored
	if err := a.M.Store.SetSetting("settings", map[string]any{
		"aiEnabled": true, "aiBaseUrl": "https://api.deepseek.com", "aiModel": "deepseek-chat", "concurrency": 3,
	}); err != nil {
		t.Fatal(err)
	}
	if err := a.M.Store.SetSecretSetting("ai_api_key", "sk-old"); err != nil {
		t.Fatal(err)
	}
	s := a.M.Settings()
	if s.AIProvider != "deepseek" || s.AIThinking != "" || s.AIModel != "deepseek-chat" || !s.AIHasKey {
		t.Fatalf("legacy view: %+v", s)
	}
	if a.M.AIKey("aliyun") != "" {
		t.Fatal("old DeepSeek key must not be used for 阿里云")
	}

	// saving moves the key into the provider slot, so it survives the new format
	s.AIThinking = "high"
	s, err := a.SaveSettings(s, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !s.AIHasKey || s.AIThinking != "high" {
		t.Fatalf("after save: %+v", s)
	}
	if k, _ := a.M.Store.GetSecretSetting("ai_api_key:deepseek"); k != "sk-old" {
		t.Fatalf("key not migrated: %q", k)
	}

	if k, _ := a.M.Store.GetSecretSetting("ai_api_key"); k != "" {
		t.Fatal("old slot must be emptied (it belongs to custom now)")
	}

	// switching provider: own key slot, defaults filled in
	s.AIProvider, s.AIBaseURL, s.AIModel = "aliyun", "", ""
	s, err = a.SaveSettings(s, "sk-ali", false)
	if err != nil {
		t.Fatal(err)
	}
	if s.AIBaseURL != core.AIProviders["aliyun"].BaseURL || s.AIModel != "qwen3.8-flash" || !s.AIHasKey {
		t.Fatalf("aliyun: %+v", s)
	}
	if a.M.AIKey("deepseek") != "sk-old" || a.M.AIKey("aliyun") != "sk-ali" {
		t.Fatal("keys must be kept per provider")
	}
	if got := a.AIKeyStatus(); !got["deepseek"] || !got["aliyun"] || got["custom"] {
		t.Fatalf("key status: %v", got)
	}

	// clearing only clears the current provider
	if _, err = a.SaveSettings(s, "", true); err != nil {
		t.Fatal(err)
	}
	if a.M.AIKey("aliyun") != "" || a.M.AIKey("deepseek") != "sk-old" {
		t.Fatal("clear must only touch the current provider")
	}

	s.AIThinking = "bogus"
	if _, err = a.SaveSettings(s, "", false); err == nil {
		t.Fatal("unknown thinking level must be rejected")
	}
}
