((Get-Content lib\rotation-generator.ts) -join "`n") -replace "DEFAULT_GEMINI_MODEL = `"gemini-2.5-flash`";", "DEFAULT_GEMINI_MODEL = `"gemini-3.8-flash`";" | Set-Content lib\rotation-generator.ts
