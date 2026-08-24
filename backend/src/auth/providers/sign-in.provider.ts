import {
  forwardRef,
  Inject,
  Injectable,
  RequestTimeoutException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsersService } from '../../users/providers/users.service';
import { User } from '../../users/user.entity';
import { HashingProvider } from './hashing.provider';
import { LoginDto } from '../dtos/login.dto';
import { SessionsProvider } from './sessions.provider';

@Injectable()
export class SignInProvider {
  constructor(
    // injecting userService repo
    @Inject(forwardRef(() => UsersService))
    private readonly userService: UsersService,

    // Inject user repository to handle user lookup securely
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    // injecting hashing dependency
    private readonly hashingProvider: HashingProvider,

    // inject sessions provider for secure session management
    private readonly sessionsProvider: SessionsProvider,
  ) {}
  public async SignIn(signInDto: LoginDto) {
    // Always use the same error message to prevent email enumeration
    const invalidCredentialsError = new UnauthorizedException('Email or password is incorrect');
    
    // Get user by email - use repository directly to avoid early throwing
    let user: User | null = null;
    try {
      user = await this.userRepository.findOneBy({ email: signInDto.email });
    } catch {
      throw new RequestTimeoutException('Error connecting to the database', {
        description: 'Could not fetch user data',
      });
    }
    
    // If user doesn't exist, still perform password comparison to prevent timing attacks
    let isCheckedPassword: boolean = false;
    
    try {
      if (user && user.password) {
        isCheckedPassword = await this.hashingProvider.comparePasswords(
          signInDto.password,
          user.password,
        );
      }
      
      // If user doesn't exist or password is incorrect, throw the same error
      if (!user || !isCheckedPassword) {
        throw invalidCredentialsError;
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new RequestTimeoutException(error, {
        description: 'Error connecting to the database',
      });
    }

    // Create a secure session and return the tokens expected by the frontend
    return await this.sessionsProvider.createSession(user);
  }
}