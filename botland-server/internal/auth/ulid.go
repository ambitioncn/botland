package auth

import (
	"math/rand"
	"time"

	"github.com/oklog/ulid/v2"
)

var entropy = rand.New(rand.NewSource(time.Now().UnixNano()))

func NewULID() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), entropy).String()
}

func NewCitizenID(citizenType string) string {
	return citizenType + "_" + NewULID()
}
