package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	AccessTokenDuration  = 15 * time.Minute
	RefreshTokenDuration = 30 * 24 * time.Hour
)

type Claims struct {
	CitizenID   string `json:"citizen_id"`
	CitizenType string `json:"citizen_type"`
	jwt.RegisteredClaims
}

type JWTService struct {
	privateKey *ecdsa.PrivateKey
	publicKey  *ecdsa.PublicKey
}

// NewJWTService loads or generates an ES256 key pair.
// keyPath: path to PEM private key file. If empty or not found, generates a new key.
func NewJWTService(keyPath string) *JWTService {
	var privKey *ecdsa.PrivateKey

	if keyPath != "" {
		if data, err := os.ReadFile(keyPath); err == nil {
			block, _ := pem.Decode(data)
			if block != nil {
				if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
					privKey = key
				}
			}
		}
	}

	if privKey == nil {
		// Generate new key pair
		var err error
		privKey, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			panic("failed to generate ECDSA key: " + err.Error())
		}

		// Save to file if path given
		if keyPath != "" {
			derBytes, _ := x509.MarshalECPrivateKey(privKey)
			pemBlock := &pem.Block{Type: "EC PRIVATE KEY", Bytes: derBytes}
			if f, err := os.Create(keyPath); err == nil {
				pem.Encode(f, pemBlock)
				f.Close()
				os.Chmod(keyPath, 0600)
			}
		}
	}

	return &JWTService{
		privateKey: privKey,
		publicKey:  &privKey.PublicKey,
	}
}

// NewJWTServiceFromSecret creates a service from a hex secret (backward compat).
// Derives a deterministic ECDSA key from the secret for migration period.
// DEPRECATED: Use NewJWTService(keyPath) instead.
func NewJWTServiceFromSecret(secret string) *JWTService {
	// Generate ephemeral key — old tokens will be invalid after restart
	privKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic("failed to generate ECDSA key: " + err.Error())
	}
	return &JWTService{
		privateKey: privKey,
		publicKey:  &privKey.PublicKey,
	}
}

func (s *JWTService) GenerateAccessToken(citizenID, citizenType string) (string, error) {
	claims := &Claims{
		CitizenID:   citizenID,
		CitizenType: citizenType,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(AccessTokenDuration)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "botland",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	return token.SignedString(s.privateKey)
}

func (s *JWTService) GenerateRefreshToken(citizenID, citizenType string) (string, error) {
	claims := &Claims{
		CitizenID:   citizenID,
		CitizenType: citizenType,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(RefreshTokenDuration)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "botland",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	return token.SignedString(s.privateKey)
}

func (s *JWTService) GenerateAPIToken(citizenID string) (string, error) {
	claims := &Claims{
		CitizenID:   citizenID,
		CitizenType: "agent",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt: jwt.NewNumericDate(time.Now()),
			Issuer:   "botland",
			// No expiry for agent API tokens
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	return token.SignedString(s.privateKey)
}

func (s *JWTService) ValidateToken(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodECDSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.publicKey, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}

// PublicKey returns the public key for external verification (e.g., JWKS endpoint).
func (s *JWTService) PublicKey() *ecdsa.PublicKey {
	return s.publicKey
}
