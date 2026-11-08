// SPDX-License-Identifier: AGPL-3.0-or-later

package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"

	"github.com/zalando/go-keyring"
)

const (
	keyringService = "io.github.shuake.aio"
	keyringUser    = "master-key"
)

// sealer encrypts secrets at rest with AES-256-GCM. The key lives in the OS
// keychain (macOS Keychain / Windows Credential Manager); if that is not
// available it falls back to a 0600 key file in the data directory.
type sealer struct {
	aead    cipher.AEAD
	backend string
}

func loadKey(dataDir string) ([]byte, string, error) {
	useKeychain := os.Getenv("SHUAKE_NO_KEYCHAIN") == ""
	if !useKeychain {
		// tests and portable mode
	} else if s, err := keyring.Get(keyringService, keyringUser); err == nil {
		if k, err := base64.StdEncoding.DecodeString(s); err == nil && len(k) == 32 {
			return k, "keychain", nil
		}
	}
	keyFile := filepath.Join(dataDir, ".master.key")
	if b, err := os.ReadFile(keyFile); err == nil {
		if k, err := base64.StdEncoding.DecodeString(string(b)); err == nil && len(k) == 32 {
			return k, "file", nil
		}
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, "", err
	}
	enc := base64.StdEncoding.EncodeToString(k)
	if useKeychain {
		if err := keyring.Set(keyringService, keyringUser, enc); err == nil {
			return k, "keychain", nil
		}
	}
	if err := os.WriteFile(keyFile, []byte(enc), 0o600); err != nil {
		return nil, "", err
	}
	return k, "file", nil
}

func newSealer(dataDir string) (*sealer, error) {
	key, backend, err := loadKey(dataDir)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &sealer{aead: aead, backend: backend}, nil
}

func (s *sealer) seal(plain []byte) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.aead.Seal(nonce, nonce, plain, nil), nil
}

func (s *sealer) open(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, nil
	}
	n := s.aead.NonceSize()
	if len(data) < n {
		return nil, errors.New("ciphertext too short")
	}
	return s.aead.Open(nil, data[:n], data[n:], nil)
}
