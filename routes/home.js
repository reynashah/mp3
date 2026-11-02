var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

function reply(res, status, message, data) {
    return res.status(status).json({ message: message, data: data });
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isNonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }
function validId(value) { return typeof value === 'string' && mongoose.isValidObjectId(value); }
function apiError(status, message) { var err = new Error(message); err.status = status; return err; }

function parseJsonQuery(value, name) {
    if (value === undefined) return undefined;
    try {
        var parsed = JSON.parse(value);
        if (!isObject(parsed)) throw new Error();
        return parsed;
    } catch (_) { throw apiError(400, 'Invalid ' + name + ' query parameter'); }
}

function parseNumber(value, name) {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(String(value))) throw apiError(400, 'Invalid ' + name + ' query parameter');
    return Number(value);
}

function optionsFor(req, defaultLimit) {
    var options = {
        where: parseJsonQuery(req.query.where, 'where') || {},
        sort: parseJsonQuery(req.query.sort, 'sort'),
        select: parseJsonQuery(req.query.select, 'select'),
        skip: parseNumber(req.query.skip, 'skip'),
        limit: parseNumber(req.query.limit, 'limit')
    };
    if (options.limit === undefined && defaultLimit !== undefined) options.limit = defaultLimit;
    options.count = String(req.query.count).toLowerCase() === 'true';
    return options;
}

function findMany(Model, options) {
    var query = Model.find(options.where);
    if (options.sort) query = query.sort(options.sort);
    if (options.select) query = query.select(options.select);
    if (options.skip !== undefined) query = query.skip(options.skip);
    if (options.limit !== undefined) query = query.limit(options.limit);
    return query;
}

function requireBody(body) {
    if (!isObject(body)) throw apiError(400, 'Request body must be a JSON object');
}

function userInput(body) {
    requireBody(body);
    if (!isNonEmptyString(body.name) || !isNonEmptyString(body.email)) throw apiError(400, 'User name and email are required');
    var pendingTasks = body.pendingTasks === undefined ? [] : body.pendingTasks;
    if (!Array.isArray(pendingTasks) || pendingTasks.some(function (id) { return !validId(id); })) {
        throw apiError(400, 'pendingTasks must be an array of valid task ids');
    }
    return { name: body.name.trim(), email: body.email.trim(), pendingTasks: Array.from(new Set(pendingTasks)) };
}

function taskInput(body) {
    requireBody(body);
    if (!isNonEmptyString(body.name)) throw apiError(400, 'Task name is required');
    if (body.deadline === undefined || (typeof body.deadline !== 'string' && !(body.deadline instanceof Date)) || isNaN(new Date(body.deadline).getTime())) {
        throw apiError(400, 'A valid task deadline is required');
    }
    if (body.description !== undefined && typeof body.description !== 'string') throw apiError(400, 'Task description must be a string');
    if (body.completed !== undefined && typeof body.completed !== 'boolean') throw apiError(400, 'Task completed must be a boolean');
    var assignedUser = body.assignedUser === undefined ? '' : body.assignedUser;
    if (typeof assignedUser !== 'string' || (assignedUser !== '' && !validId(assignedUser))) throw apiError(400, 'assignedUser must be an empty string or a valid user id');
    if (body.assignedUserName !== undefined && typeof body.assignedUserName !== 'string') throw apiError(400, 'assignedUserName must be a string');
    return { name: body.name.trim(), description: body.description === undefined ? '' : body.description, deadline: new Date(body.deadline), completed: body.completed === undefined ? false : body.completed, assignedUser: assignedUser, assignedUserName: body.assignedUserName };
}

async function ensureTasks(ids, session) {
    if (!ids.length) return;
    var tasks = await Task.find({ _id: { $in: ids } }).session(session);
    if (tasks.length !== ids.length) throw apiError(404, 'One or more tasks were not found');
    if (tasks.some(function (task) { return task.completed; })) throw apiError(400, 'Completed tasks cannot be pending tasks');
}

async function assignee(input, session) {
    if (!input.assignedUser) return null;
    var user = await User.findById(input.assignedUser).session(session);
    if (!user) throw apiError(404, 'Assigned user was not found');
    if (input.assignedUserName !== undefined && input.assignedUserName !== user.name) throw apiError(400, 'assignedUserName must match the assigned user');
    return user;
}

async function inTransaction(work) {
    var session = await mongoose.startSession();
    try {
        var result;
        await session.withTransaction(async function () { result = await work(session); });
        return result;
    } finally { await session.endSession(); }
}

function failure(res, err) {
    if (err && err.code === 11000) return reply(res, 400, 'Email is already in use', null);
    if (err && err.status) return reply(res, err.status, err.message, null);
    console.error(err);
    return reply(res, 500, 'Internal server error', null);
}

async function list(Model, req, res, defaultLimit) {
    try {
        var options = optionsFor(req, defaultLimit);
        return reply(res, 200, 'OK', options.count ? await Model.countDocuments(options.where) : await findMany(Model, options));
    } catch (err) { return failure(res, err); }
}

async function one(Model, label, req, res) {
    try {
        if (!validId(req.params.id)) return reply(res, 404, label + ' not found', null);
        var select = parseJsonQuery(req.query.select, 'select');
        var query = Model.findById(req.params.id);
        if (select) query = query.select(select);
        var doc = await query;
        return doc ? reply(res, 200, 'OK', doc) : reply(res, 404, label + ' not found', null);
    } catch (err) { return failure(res, err); }
}

module.exports = function (router) {
    router.get('/', function (_req, res) { return reply(res, 200, 'API is running', null); });

    router.route('/users').get(function (req, res) { return list(User, req, res); }).post(async function (req, res) {
        try {
            var input = userInput(req.body);
            var user = await inTransaction(async function (session) {
                await ensureTasks(input.pendingTasks, session);
                if (await User.exists({ email: input.email }).session(session)) throw apiError(400, 'Email is already in use');
                var created = (await User.create([input], { session: session }))[0];
                if (input.pendingTasks.length) {
                    await User.updateMany({ _id: { $ne: created._id } }, { $pull: { pendingTasks: { $in: input.pendingTasks } } }, { session: session });
                    await Task.updateMany({ _id: { $in: input.pendingTasks } }, { $set: { assignedUser: String(created._id), assignedUserName: created.name } }, { session: session });
                }
                return created;
            });
            return reply(res, 201, 'Created', user);
        } catch (err) { return failure(res, err); }
    });

    router.route('/users/:id').get(function (req, res) { return one(User, 'User', req, res); }).put(async function (req, res) {
        try {
            if (!validId(req.params.id)) return reply(res, 404, 'User not found', null);
            var input = userInput(req.body);
            var user = await inTransaction(async function (session) {
                var old = await User.findById(req.params.id).session(session);
                if (!old) throw apiError(404, 'User not found');
                if (await User.exists({ email: input.email, _id: { $ne: old._id } }).session(session)) throw apiError(400, 'Email is already in use');
                await ensureTasks(input.pendingTasks, session);
                var oldPending = (await Task.find({ assignedUser: String(old._id), completed: false }).session(session)).map(function (task) { return String(task._id); });
                var removed = oldPending.filter(function (id) { return !input.pendingTasks.includes(id); });
                if (removed.length) await Task.updateMany({ _id: { $in: removed } }, { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session: session });
                if (input.pendingTasks.length) {
                    await User.updateMany({ _id: { $ne: old._id } }, { $pull: { pendingTasks: { $in: input.pendingTasks } } }, { session: session });
                    await Task.updateMany({ _id: { $in: input.pendingTasks } }, { $set: { assignedUser: String(old._id), assignedUserName: input.name } }, { session: session });
                }
                await Task.updateMany({ assignedUser: String(old._id), _id: { $nin: input.pendingTasks } }, { $set: { assignedUserName: input.name } }, { session: session });
                old.name = input.name; old.email = input.email; old.pendingTasks = input.pendingTasks;
                await old.save({ session: session });
                return old;
            });
            return reply(res, 200, 'OK', user);
        } catch (err) { return failure(res, err); }
    }).delete(async function (req, res) {
        try {
            if (!validId(req.params.id)) return reply(res, 404, 'User not found', null);
            await inTransaction(async function (session) {
                var user = await User.findById(req.params.id).session(session);
                if (!user) throw apiError(404, 'User not found');
                await Task.updateMany({ assignedUser: String(user._id) }, { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session: session });
                await User.deleteOne({ _id: user._id }, { session: session });
            });
            return res.status(204).send();
        } catch (err) { return failure(res, err); }
    });

    router.route('/tasks').get(function (req, res) { return list(Task, req, res, 100); }).post(async function (req, res) {
        try {
            var input = taskInput(req.body);
            var task = await inTransaction(async function (session) {
                var user = await assignee(input, session);
                input.assignedUserName = user ? user.name : 'unassigned';
                var created = (await Task.create([input], { session: session }))[0];
                if (user && !created.completed) await User.updateOne({ _id: user._id }, { $addToSet: { pendingTasks: String(created._id) } }, { session: session });
                return created;
            });
            return reply(res, 201, 'Created', task);
        } catch (err) { return failure(res, err); }
    });

    router.route('/tasks/:id').get(function (req, res) { return one(Task, 'Task', req, res); }).put(async function (req, res) {
        try {
            if (!validId(req.params.id)) return reply(res, 404, 'Task not found', null);
            var input = taskInput(req.body);
            var task = await inTransaction(async function (session) {
                var old = await Task.findById(req.params.id).session(session);
                if (!old) throw apiError(404, 'Task not found');
                var user = await assignee(input, session);
                input.assignedUserName = user ? user.name : 'unassigned';
                Object.assign(old, input);
                await old.save({ session: session });
                await User.updateMany({}, { $pull: { pendingTasks: String(old._id) } }, { session: session });
                if (user && !old.completed) await User.updateOne({ _id: user._id }, { $addToSet: { pendingTasks: String(old._id) } }, { session: session });
                return old;
            });
            return reply(res, 200, 'OK', task);
        } catch (err) { return failure(res, err); }
    }).delete(async function (req, res) {
        try {
            if (!validId(req.params.id)) return reply(res, 404, 'Task not found', null);
            await inTransaction(async function (session) {
                var task = await Task.findById(req.params.id).session(session);
                if (!task) throw apiError(404, 'Task not found');
                await User.updateMany({}, { $pull: { pendingTasks: String(task._id) } }, { session: session });
                await Task.deleteOne({ _id: task._id }, { session: session });
            });
            return res.status(204).send();
        } catch (err) { return failure(res, err); }
    });

    return router;
};
