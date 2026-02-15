' IDM API Helper - VBScript wrapper for Internet Download Manager COM interface
' Arguments: URL, Referrer, Cookie, PostData, Username, Password, OutputPath, OutputFilename, UserAgent, Flags

Function Main()
    Dim url, referrer, cookie, postData, username, password
    Dim outputPath, outputFilename, userAgent, flags
    Dim idmObj, reserved1, reserved2
    Dim success
    
    On Error Resume Next
    
    ' Get command line arguments
    Dim args
    Set args = WScript.Arguments
    
    If args.Count < 1 Then
        WScript.Echo "{""error"":""URL is required"",""success"":false}"
        WScript.Quit 1
    End If
    
    url = args(0)
    referrer = IIf(args.Count > 1, args(1), "")
    cookie = IIf(args.Count > 2, args(2), "")
    postData = IIf(args.Count > 3, args(3), "")
    username = IIf(args.Count > 4, args(4), "")
    password = IIf(args.Count > 5, args(5), "")
    outputPath = IIf(args.Count > 6, args(6), "")
    outputFilename = IIf(args.Count > 7, args(7), "")
    userAgent = IIf(args.Count > 8, args(8), "")
    flags = IIf(args.Count > 9, CInt(args(9)), 1)
    
    ' Create IDM COM object
    Set idmObj = CreateObject("IDMan.CIDMLinkTransmitter")
    
    If Err.Number <> 0 Then
        WScript.Echo "{""error"":""Internet Download Manager not found. Please install IDM first."",""success"":false}"
        WScript.Quit 1
    End If
    
    ' Call SendLinkToIDM2
    ' Parameters: URL, Referrer, Cookie, PostData, Username, Password, OutputPath, OutputFilename, Flags, reserved1, reserved2
    idmObj.SendLinkToIDM2 url, referrer, cookie, postData, username, password, outputPath, outputFilename, flags, Empty, Empty
    
    If Err.Number <> 0 Then
        WScript.Echo "{""error"":""" & EscapeJSON(Err.Description) & """,""success"":false}"
        WScript.Quit 1
    End If
    
    WScript.Echo "{""success"":true,""message"":""Download sent to IDM successfully""}"
    WScript.Quit 0
End Function

' Helper function to escape JSON special characters
Function EscapeJSON(str)
    Dim result
    result = str
    result = Replace(result, "\", "\\")
    result = Replace(result, """", "\""")
    result = Replace(result, Chr(13), "\r")
    result = Replace(result, Chr(10), "\n")
    result = Replace(result, Chr(9), "\t")
    EscapeJSON = result
End Function

' Run the main function
Main()
