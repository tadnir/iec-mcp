# Contributing

Never commit session files, tokens, HAR captures, real invoice PDFs or real account numbers. Tests use made-up ids and recorded shapes only.

```sh
npm install
npm run check
```

Read-only calls only: nothing that pays, changes the account or sends requests to IEC on the user's behalf.
