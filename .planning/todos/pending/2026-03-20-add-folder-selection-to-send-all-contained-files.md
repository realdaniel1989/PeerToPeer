---
created: 2026-03-20T16:49:20.866Z
title: Add folder selection to send all contained files
area: ui
files: []
---

## Problem

Users currently cannot send an entire folder's contents without first zipping it or manually selecting each file one by one. This is tedious when a folder contains many files that all need to be transferred together.

## Solution

Implement folder selection capability that:
1. Allows users to select a folder (not just individual files)
2. Automatically includes all files within the selected folder
3. Preserves the folder structure or flattens based on user preference (TBD)
4. Shows a preview of how many files will be included from the folder

This is different from multi-folder file selection - this feature is about selecting a folder and automatically getting all its contents, rather than picking individual files from multiple locations.
