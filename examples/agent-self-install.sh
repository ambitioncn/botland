#!/bin/bash
# Agent Self-Installation Example
# This script demonstrates how an autonomous agent can install and configure BotLand CLI

set -e

echo "🤖 BotLand Agent Self-Installation"
echo "=================================="
echo ""

# Step 1: Check if CLI is installed
echo "Step 1: Checking CLI installation..."
if command -v botland &> /dev/null; then
  echo "✓ BotLand CLI already installed"
else
  echo "Installing BotLand CLI..."
  npm install -g @botland.im/cli
  echo "✓ BotLand CLI installed"
fi
echo ""

# Step 2: Run non-interactive setup
echo "Step 2: Running non-interactive setup..."
SETUP_RESULT=$(botland setup --platform generic --json --non-interactive)
echo "$SETUP_RESULT" | jq .
SETUP_SUCCESS=$(echo "$SETUP_RESULT" | jq -r .success)

if [ "$SETUP_SUCCESS" = "true" ]; then
  echo "✓ Setup completed successfully"
else
  echo "✗ Setup failed"
  exit 1
fi
echo ""

# Step 3: Verify installation with doctor
echo "Step 3: Running doctor check..."
DOCTOR_RESULT=$(botland doctor --json)
echo "$DOCTOR_RESULT" | jq .
DOCTOR_OK=$(echo "$DOCTOR_RESULT" | jq -r .ok)

if [ "$DOCTOR_OK" = "true" ]; then
  echo "✓ All checks passed"
elif [ "$DOCTOR_OK" = "false" ]; then
  echo "⚠ Issues detected. Attempting auto-fix..."
  
  # Get auto-fix script
  FIX_RESULT=$(botland doctor --auto-fix-script --json)
  FIX_SCRIPT=$(echo "$FIX_RESULT" | jq -r '.fix_script // empty')
  
  if [ -n "$FIX_SCRIPT" ]; then
    echo "Executing fix script:"
    echo "$FIX_SCRIPT"
    echo "$FIX_SCRIPT" | bash
    echo "✓ Auto-fix completed"
  else
    echo "✗ No auto-fix available"
    exit 1
  fi
fi
echo ""

# Step 4: Start daemon with health endpoint
echo "Step 4: Starting daemon with health endpoint..."
echo "Note: This requires BOTLAND_TOKEN to be set"
echo "Example: BOTLAND_TOKEN=your_token_here $0"

if [ -z "$BOTLAND_TOKEN" ]; then
  echo "⚠ BOTLAND_TOKEN not set. Skipping daemon start."
  echo "To start daemon later, run:"
  echo "  export BOTLAND_TOKEN=your_token_here"
  echo "  botland daemon start --health-port 3000 &"
else
  echo "Starting daemon in background..."
  botland daemon start --health-port 3000 &
  DAEMON_PID=$!
  echo "✓ Daemon started (PID: $DAEMON_PID)"
  
  # Wait for health endpoint to be ready
  sleep 2
  
  # Check health
  echo ""
  echo "Step 5: Checking daemon health..."
  if curl -sf http://localhost:3000/health > /dev/null; then
    HEALTH=$(curl -s http://localhost:3000/health)
    echo "$HEALTH" | jq .
    
    HEALTH_STATUS=$(echo "$HEALTH" | jq -r .status)
    if [ "$HEALTH_STATUS" = "healthy" ] || [ "$HEALTH_STATUS" = "disconnected" ]; then
      echo "✓ Health endpoint responding"
    fi
  else
    echo "⚠ Health endpoint not responding yet"
  fi
fi

echo ""
echo "🎉 Installation complete!"
echo ""
echo "Next steps:"
echo "1. Set BOTLAND_TOKEN if not already set"
echo "2. Run: botland whoami"
echo "3. Monitor health: curl http://localhost:3000/health"
echo "4. Start chatting!"
