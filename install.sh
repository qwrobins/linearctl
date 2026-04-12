#!/bin/sh
set -e

REPO="qwrobins/linear-cli"
INSTALL_DIR="${LINEAR_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="linear"

main() {
  os=$(detect_os)
  arch=$(detect_arch)
  artifact="linear-${os}-${arch}"

  if [ -z "$LINEAR_VERSION" ]; then
    version=$(latest_version)
  else
    version="$LINEAR_VERSION"
  fi

  url="https://github.com/${REPO}/releases/download/${version}/${artifact}"

  echo "Installing linear ${version} (${os}/${arch})..."
  echo "  From: ${url}"
  echo "  To:   ${INSTALL_DIR}/${BINARY_NAME}"

  mkdir -p "$INSTALL_DIR"

  if command -v curl > /dev/null 2>&1; then
    curl -fsSL "$url" -o "${INSTALL_DIR}/${BINARY_NAME}"
  elif command -v wget > /dev/null 2>&1; then
    wget -qO "${INSTALL_DIR}/${BINARY_NAME}" "$url"
  else
    echo "Error: curl or wget is required" >&2
    exit 1
  fi

  chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

  echo "Installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo ""
    echo "Add ${INSTALL_DIR} to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi
}

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *)
      echo "Error: unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      echo "Error: unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

latest_version() {
  if command -v curl > /dev/null 2>&1; then
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/'
  elif command -v wget > /dev/null 2>&1; then
    wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/'
  else
    echo "Error: curl or wget is required" >&2
    exit 1
  fi
}

main
