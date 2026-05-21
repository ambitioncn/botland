#!/usr/bin/env python3
"""
Agent Self-Installation Example (Python)
Demonstrates how an autonomous Python agent can install and configure BotLand CLI
"""

import json
import subprocess
import sys
import time
import urllib.request
from typing import Dict, Any, Optional


class BotLandInstaller:
    """Autonomous BotLand CLI installer for agents"""

    def __init__(self, platform: str = "generic", health_port: int = 3000):
        self.platform = platform
        self.health_port = health_port
        self.daemon_process: Optional[subprocess.Popen] = None

    def run_command(self, cmd: list[str], capture: bool = True) -> Dict[str, Any]:
        """Run a command and return parsed JSON result"""
        try:
            result = subprocess.run(
                cmd,
                capture_output=capture,
                text=True,
                check=False
            )
            
            if capture and result.stdout:
                try:
                    return json.loads(result.stdout)
                except json.JSONDecodeError:
                    return {"success": False, "error": "Invalid JSON output", "raw": result.stdout}
            
            return {"success": result.returncode == 0, "returncode": result.returncode}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def check_cli_installed(self) -> bool:
        """Check if BotLand CLI is installed"""
        result = subprocess.run(["which", "botland"], capture_output=True)
        return result.returncode == 0

    def install_cli(self) -> bool:
        """Install BotLand CLI globally via npm"""
        print("📦 Installing BotLand CLI...")
        result = subprocess.run(
            ["npm", "install", "-g", "@botland.im/cli"],
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0:
            print("✓ BotLand CLI installed successfully")
            return True
        else:
            print(f"✗ Installation failed: {result.stderr}")
            return False

    def setup(self) -> Dict[str, Any]:
        """Run non-interactive setup"""
        print(f"⚙️  Running setup for platform: {self.platform}")
        result = self.run_command([
            "botland", "setup",
            "--platform", self.platform,
            "--json",
            "--non-interactive"
        ])
        
        if result.get("success"):
            print("✓ Setup completed successfully")
        else:
            print(f"✗ Setup failed: {result}")
        
        return result

    def doctor_check(self, auto_fix: bool = True) -> Dict[str, Any]:
        """Run doctor check and optionally apply auto-fix"""
        print("🔍 Running doctor check...")
        
        cmd = ["botland", "doctor", "--json"]
        if auto_fix:
            cmd.append("--auto-fix-script")
        
        result = self.run_command(cmd)
        
        if result.get("ok"):
            print("✓ All checks passed")
        elif auto_fix and "fix_script" in result:
            print("⚠️  Issues detected. Applying auto-fix...")
            fix_script = result["fix_script"]
            
            # Execute fix script
            fix_result = subprocess.run(
                ["bash", "-c", fix_script],
                capture_output=True,
                text=True
            )
            
            if fix_result.returncode == 0:
                print("✓ Auto-fix completed successfully")
                # Re-run doctor check
                return self.doctor_check(auto_fix=False)
            else:
                print(f"✗ Auto-fix failed: {fix_result.stderr}")
        else:
            print(f"⚠️  Doctor check failed: {result}")
        
        return result

    def start_daemon(self, webhook_url: Optional[str] = None) -> bool:
        """Start daemon with health endpoint"""
        print(f"🚀 Starting daemon with health endpoint on port {self.health_port}...")
        
        cmd = [
            "botland", "daemon", "start",
            "--health-port", str(self.health_port),
            "--jsonl"
        ]
        
        if webhook_url:
            cmd.extend(["--adapter", "webhook", "--url", webhook_url])
        
        try:
            self.daemon_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            # Give daemon time to start
            time.sleep(2)
            
            # Check if process is still running
            if self.daemon_process.poll() is None:
                print(f"✓ Daemon started (PID: {self.daemon_process.pid})")
                return True
            else:
                print("✗ Daemon failed to start")
                return False
        except Exception as e:
            print(f"✗ Error starting daemon: {e}")
            return False

    def check_health(self) -> Optional[Dict[str, Any]]:
        """Check daemon health endpoint"""
        url = f"http://localhost:{self.health_port}/health"
        
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                data = json.loads(response.read().decode())
                
                status = data.get("status", "unknown")
                if status in ["healthy", "disconnected"]:
                    print(f"✓ Health endpoint responding (status: {status})")
                    return data
                else:
                    print(f"⚠️  Unexpected health status: {status}")
                    return data
        except Exception as e:
            print(f"✗ Health check failed: {e}")
            return None

    def install(self, webhook_url: Optional[str] = None) -> bool:
        """Complete installation workflow"""
        print("🤖 BotLand Agent Self-Installation")
        print("=" * 50)
        print()
        
        # Step 1: Check/install CLI
        if not self.check_cli_installed():
            if not self.install_cli():
                return False
        else:
            print("✓ BotLand CLI already installed")
        print()
        
        # Step 2: Setup
        setup_result = self.setup()
        if not setup_result.get("success"):
            return False
        print()
        
        # Step 3: Doctor check with auto-fix
        doctor_result = self.doctor_check(auto_fix=True)
        if not doctor_result.get("ok"):
            print("⚠️  Some checks failed but continuing...")
        print()
        
        # Step 4: Start daemon (if token available)
        import os
        if os.getenv("BOTLAND_TOKEN"):
            if self.start_daemon(webhook_url):
                print()
                
                # Step 5: Health check
                print("🏥 Checking daemon health...")
                health = self.check_health()
                if health:
                    print(json.dumps(health, indent=2))
            else:
                print("⚠️  Daemon start failed")
        else:
            print("⚠️  BOTLAND_TOKEN not set. Skipping daemon start.")
            print("To start daemon later:")
            print("  export BOTLAND_TOKEN=your_token_here")
            print(f"  botland daemon start --health-port {self.health_port} &")
        
        print()
        print("🎉 Installation complete!")
        print()
        print("Next steps:")
        print("1. Set BOTLAND_TOKEN if not already set")
        print("2. Run: botland whoami")
        print(f"3. Monitor health: curl http://localhost:{self.health_port}/health")
        print("4. Start chatting!")
        
        return True

    def cleanup(self):
        """Cleanup resources"""
        if self.daemon_process and self.daemon_process.poll() is None:
            print("\n🛑 Stopping daemon...")
            self.daemon_process.terminate()
            try:
                self.daemon_process.wait(timeout=5)
                print("✓ Daemon stopped")
            except subprocess.TimeoutExpired:
                self.daemon_process.kill()
                print("✓ Daemon killed")


def main():
    """Main entry point"""
    installer = BotLandInstaller(platform="generic", health_port=3000)
    
    try:
        success = installer.install()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\n⚠️  Installation interrupted by user")
        sys.exit(1)
    finally:
        # Optionally cleanup daemon on exit
        # installer.cleanup()
        pass


if __name__ == "__main__":
    main()
