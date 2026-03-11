# Get Readability.js

This extension needs Mozilla's Readability.js file.

## Steps

1. Go to: https://raw.githubusercontent.com/mozilla/readability/main/Readability.js
2. Press Ctrl+S to save
3. Save it as `Readability.js` directly inside the `read-aloud-extension/` folder

Final structure should look like:
```
read-aloud-extension/
├── manifest.json
├── Readability.js    ← the file you just downloaded
├── content.js
└── icons/
    ├── icon-48.png
    └── icon-128.png
```

Then load the extension in Chrome (see README or main instructions).
