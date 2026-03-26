@echo off
cd /d "C:\Users\pcond\vs-code-projects\career-future"

echo.
echo ========================================
echo   Career Future - QA Check
echo ========================================
echo.

if "%1"=="--fix" (
    echo Running with auto-fix...
    node qa_check.cjs --fix
) else if "%1"=="--staged" (
    echo Checking staged files only...
    node qa_check.cjs --staged
) else if "%1"=="--gate" (
    echo Running gate %2 only...
    node qa_check.cjs --gate %2
) else (
    echo Running all gates...
    node qa_check.cjs
)

echo.
if %ERRORLEVEL% EQU 0 (
    echo QA PASSED - safe to commit
) else (
    echo QA FAILED - fix issues before committing
)

echo.
pause
