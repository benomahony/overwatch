if vim.g.loaded_overwatch then return end
vim.g.loaded_overwatch = 1

vim.api.nvim_create_user_command('OverwatchStart', function() require('overwatch').start() end, {})
vim.api.nvim_create_user_command('OverwatchStop', function() require('overwatch').stop() end, {})

local group = vim.api.nvim_create_augroup('overwatch', {})
vim.api.nvim_create_autocmd('VimEnter', { group = group, callback = function() require('overwatch').start() end })
vim.api.nvim_create_autocmd('BufWritePost', { group = group, callback = function() require('overwatch').changed() end })
vim.api.nvim_create_autocmd('VimLeavePre', { group = group, callback = function() require('overwatch').stop() end })
