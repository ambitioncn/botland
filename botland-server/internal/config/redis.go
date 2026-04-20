package config

import (
	"context"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

func ConnectRedis(cfg *Config, logger *slog.Logger) (*redis.Client, error) {
	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, err
	}
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		return nil, err
	}
	logger.Info("redis connected")
	return rdb, nil
}
