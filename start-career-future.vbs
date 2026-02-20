Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\pcond\salesforce-projects\career-future"
WshShell.Run "node index.js", 0, False
