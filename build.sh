#!/bin/sh
# Build the approval panel. Needs Xcode's Swift toolchain and the macOS 26 SDK or newer.
set -e
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macos26.0 ui/ApprovalPanel.swift -o bin/approve-ui
echo "built bin/approve-ui"
