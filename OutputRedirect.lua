---@diagnostic disable: undefined-global
if not game:IsLoaded() then
    game.Loaded:Wait()
end


function attemptConnection()
    local success, ws = pcall(syn.websocket.connect, "ws://localhost:24892/")

    if not success then
        task.wait(.1)
        return attemptConnection()
    end

    return ws
end

local logService = game:GetService("LogService")
local httpService = game:GetService("HttpService")
local scriptContext = game:GetService("ScriptContext")
local ws = attemptConnection()



function attemptSend(data)
    data = httpService:JSONEncode(data)

    local success = pcall(function()
        ws:Send(data)
    end)

    if not success then
        ws = attemptConnection()
        task.wait(.1)
        attemptSend(data)
    end
end


function getLogs()
    for _, log in next, logService:GetLogHistory() do
        local info = {
            message = log.message,
            messageType = log.messageType.Name
        }

        attemptSend(info)
    end
end



scriptContext.ErrorDetailed:Connect(function(message, st)
    local info = {
        message = message,
        stacktrace = st,
        messageType = Enum.MessageType.MessageError.Name
    }

    attemptSend(info)
end)

logService.MessageOut:Connect(function(message, messageType)
    local info = {
        message = message,
        messageType = messageType.Name
    }

    attemptSend(info)
end)



getLogs()
