---
created: 2026-03-20T16:49:20.866Z
title: Add multi-folder file selection capability
area: ui
files: []
---

## Problem

Currently, users can only add files from a single folder before generating a share code. This limits flexibility when users want to send files from different directories in one transfer session.

## Solution

Implement UI enhancement that allows users to:
1. Add files from multiple folders in sequence
2. See a combined list of all selected files from different directories
3. Remove individual files from the selection before finalizing

The file picker should support repeated "Add files" actions that append to the current selection rather than replace it.
