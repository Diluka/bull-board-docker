import express from 'express';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import config from './config.js';

export const authRouter = express.Router();

passport.use(
  new LocalStrategy(function(username: string, password: string, cb) {
    if (username === config.USER_LOGIN && password === config.USER_PASSWORD) {
      return cb(null, { user: 'bull-board' });
    }

    return cb(null, false);
  }),
);

passport.serializeUser((user: any, cb) => {
  cb(null, user);
});

passport.deserializeUser((user: any, cb) => {
  cb(null, user);
});

authRouter
  .route('/')
  .get((req, res) => {
    res.render('login');
  })
  .post(
    passport.authenticate('local', {
      successRedirect: config.PROXY_HOME_PAGE,
      failureRedirect: config.PROXY_LOGIN_PAGE,
    }),
  );